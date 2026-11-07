package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/mail"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"tropa/backend/internal/auth"
	"tropa/backend/internal/domain"
	"tropa/backend/internal/store"
)

type Config struct {
	Origins           []string
	HTTPS             bool
	TrustedProxyCIDRs []netip.Prefix
	ProxyToken        []byte
	AuthRateKey       []byte
	AccountLifecycle  *AccountLifecycleConfig
}
type authBudget interface {
	ConsumeAuthAttempt(context.Context, string, [32]byte) (store.AuthAttempt, error)
}
type Server struct {
	DB         *store.Store
	cfg        Config
	authSlots  chan struct{}
	limiter    *limiter
	dummyHash  string
	authBudget authBudget
	lifecycle  *accountLifecycle
}
type window struct {
	count   int
	expires time.Time
}
type limiter struct {
	mu      sync.Mutex
	entries map[string]window
}

func (l *limiter) allow(key string, max int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if len(l.entries) > 10000 {
		for k, v := range l.entries {
			if now.After(v.expires) {
				delete(l.entries, k)
			}
		}
		if len(l.entries) > 10000 {
			return false
		}
	}
	v := l.entries[key]
	if now.After(v.expires) {
		v = window{expires: now.Add(time.Minute)}
	}
	v.count++
	l.entries[key] = v
	return v.count <= max
}

func New(db *store.Store, cfg Config) (*Server, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	cfg.AuthRateKey = append([]byte(nil), cfg.AuthRateKey...)
	cfg.ProxyToken = append([]byte(nil), cfg.ProxyToken...)
	cfg.TrustedProxyCIDRs = append([]netip.Prefix(nil), cfg.TrustedProxyCIDRs...)
	dummy, e := auth.HashPassword("not-an-account-password-" + strconv.FormatInt(time.Now().UnixNano(), 10))
	if e != nil {
		return nil, e
	}
	lifecycle, e := newAccountLifecycle(db, cfg.AccountLifecycle)
	if e != nil {
		return nil, e
	}
	return &Server{DB: db, cfg: cfg, authSlots: make(chan struct{}, 4), limiter: &limiter{entries: map[string]window{}}, dummyHash: dummy, authBudget: db, lifecycle: lifecycle}, nil
}
func (s *Server) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /api/v1/health/live", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]string{"status": "ok"}) })
	m.HandleFunc("GET /api/v1/health/ready", func(w http.ResponseWriter, r *http.Request) {
		if e := s.DB.Ready(r.Context()); e != nil {
			failure(w, 503, "not_ready", "База данных недоступна.")
			return
		}
		respond(w, 200, map[string]string{"status": "ready"})
	})
	m.HandleFunc("GET /api/v1/regions", s.regions)
	m.HandleFunc("GET /api/v1/guides", s.guides)
	m.HandleFunc("GET /api/v1/guides/{id}", s.guides)
	m.HandleFunc("GET /api/v1/guides/{id}/reviews", s.guideReviews)
	m.HandleFunc("GET /api/v1/routes", s.routes)
	m.HandleFunc("GET /api/v1/routes/{id}", s.route)
	m.HandleFunc("GET /api/v1/departures", s.departures)
	m.HandleFunc("POST /api/v1/departures", s.createDeparture)
	m.HandleFunc("GET /api/v1/departures/{id}", s.departure)
	m.HandleFunc("GET /api/v1/departures/{id}/participants", s.participants)
	m.HandleFunc("POST /api/v1/auth/register", s.register)
	m.HandleFunc("POST /api/v1/auth/login", s.login)
	m.HandleFunc("POST /api/v1/auth/logout", s.logout)
	s.accountLifecycleRoutes(m)
	m.HandleFunc("GET /api/v1/me", s.me)
	m.HandleFunc("GET /api/v1/me/summary", s.accountSummary)
	m.HandleFunc("GET /api/v1/me/departures", s.departureHistory)
	m.HandleFunc("GET /api/v1/me/notifications", s.notifications)
	m.HandleFunc("POST /api/v1/me/notifications/{id}/read", s.readNotification)
	m.HandleFunc("GET /api/v1/me/reports", s.myReports)
	m.HandleFunc("POST /api/v1/reports", s.createReport)
	m.HandleFunc("GET /api/v1/me/moderation-actions", s.myModerationActions)
	m.HandleFunc("GET /api/v1/me/appeals", s.myAppeals)
	m.HandleFunc("POST /api/v1/moderation-actions/{id}/appeals", s.createAppeal)
	m.HandleFunc("GET /api/v1/moderation/reports", s.moderationReports)
	m.HandleFunc("POST /api/v1/moderation/reports/{id}/resolve", s.resolveReport)
	m.HandleFunc("GET /api/v1/moderation/appeals", s.moderationAppeals)
	m.HandleFunc("POST /api/v1/moderation/appeals/{id}/resolve", s.resolveAppeal)
	m.HandleFunc("PATCH /api/v1/me/profile", s.profile)
	m.HandleFunc("POST /api/v1/departures/{id}/join", s.join)
	m.HandleFunc("POST /api/v1/departures/{id}/leave", s.leave)
	m.HandleFunc("POST /api/v1/departures/{id}/check-in", s.checkIn)
	m.HandleFunc("POST /api/v1/departures/{id}/transition", s.transition)
	m.HandleFunc("GET /api/v1/departures/{id}/safety-passport", s.safetyPassport)
	m.HandleFunc("POST /api/v1/departures/{id}/safety-passport/prepare", s.prepareSafetyPassport)
	m.HandleFunc("POST /api/v1/departures/{id}/mchs/submission", s.recordMCHSSubmission)
	m.HandleFunc("POST /api/v1/departures/{id}/mchs/confirmation", s.confirmMCHSRegistration)
	m.HandleFunc("POST /api/v1/departures/{id}/mchs/start-contact", s.confirmMCHSStartContact)
	m.HandleFunc("POST /api/v1/departures/{id}/mchs/return-report", s.reportMCHSReturn)
	m.HandleFunc("POST /api/v1/departures/{id}/safety-check-ins", s.safetyCheckIn)
	m.HandleFunc("GET /api/v1/departures/{id}/emergency-card", s.emergencyCard)
	m.HandleFunc("GET /api/v1/departures/{id}/messages", s.messages)
	m.HandleFunc("POST /api/v1/departures/{id}/messages", s.sendMessage)
	m.HandleFunc("GET /api/v1/departures/{id}/reviews", s.reviews)
	m.HandleFunc("POST /api/v1/departures/{id}/reviews", s.review)
	m.HandleFunc("POST /api/v1/sync/observations", s.observations)
	m.HandleFunc("GET /api/v1/recruitment-requests", s.recruitmentList)
	m.HandleFunc("POST /api/v1/recruitment-requests", s.recruitmentCreate)
	m.HandleFunc("POST /api/v1/recruitment-requests/{id}/join", s.recruitmentJoin)
	m.HandleFunc("POST /api/v1/recruitment-requests/{id}/leave", s.recruitmentLeave)
	m.HandleFunc("POST /api/v1/recruitment-requests/{id}/accept", s.recruitmentAccept)
	m.HandleFunc("GET /api/v1/recruitment-requests/{id}/messages", s.recruitmentMessages)
	m.HandleFunc("POST /api/v1/recruitment-requests/{id}/messages", s.recruitmentMessage)
	m.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		failure(w, 404, "not_found", "Ресурс не найден.")
	})
	return s.middleware(m)
}

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		if s.cfg.HTTPS {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			allowed := false
			for _, x := range s.cfg.Origins {
				if origin == x {
					allowed = true
					break
				}
			}
			if !allowed {
				failure(w, 403, "origin_denied", "Источник запроса не разрешён.")
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		defer func() {
			if recover() != nil {
				slog.Error("request panic recovered", "path", r.URL.Path)
				failure(w, 500, "internal_error", "Запрос не выполнен. Повторите позже.")
			}
		}()
		if r.Method != http.MethodGet && !strings.HasPrefix(r.URL.Path, "/api/v1/auth/") {
			ip := s.clientIP(r)
			if !s.limiter.allow("write:"+ip, 120) {
				failure(w, 429, "rate_limited", "Слишком много запросов. Повторите через минуту.")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func respond(w http.ResponseWriter, status int, value any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"data": value, "meta": map[string]string{"mode": "production"}})
}
func failure(w http.ResponseWriter, status int, code, message string) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": message}})
}
func fail(w http.ResponseWriter, e error) {
	switch {
	case errors.Is(e, domain.ErrUnauthorized):
		failure(w, 401, "unauthorized", "Войдите в аккаунт.")
	case errors.Is(e, domain.ErrForbidden):
		failure(w, 403, "forbidden", "Действие недоступно для вашей роли или текущего участия.")
	case errors.Is(e, domain.ErrNotFound):
		failure(w, 404, "not_found", "Ресурс не найден.")
	case errors.Is(e, domain.ErrInvalid):
		failure(w, 400, "invalid_request", "Проверьте данные запроса.")
	case errors.Is(e, domain.ErrFull):
		failure(w, 409, "departure_full", "Свободных мест больше нет.")
	case errors.Is(e, domain.ErrNotReady):
		failure(w, 409, "departure_not_ready", "Условия похода изменились или ещё не выполнены. Обновите данные.")
	case errors.Is(e, domain.ErrClosed):
		failure(w, 409, "route_closed", "Набор на этот маршрут приостановлен.")
	case errors.Is(e, domain.ErrConflict):
		failure(w, 409, "conflict", "Данные изменились. Обновите страницу перед повтором.")
	case errors.Is(e, domain.ErrDuplicate):
		failure(w, 409, "already_exists", "Такая запись уже существует.")
	case errors.Is(e, domain.ErrMuted):
		failure(w, 429, "temporarily_muted", "Публикация временно ограничена. Причина, срок и обжалование доступны в личном кабинете.")
	case errors.Is(e, domain.ErrSpamCooldown):
		w.Header().Set("Retry-After", "60")
		failure(w, 429, "posting_cooldown", "Сообщение не отправлено: превышен лимит публикаций. Подождите и повторите позже.")
	case errors.Is(e, domain.ErrRepeated):
		failure(w, 429, "repeated_content", "Этот текст уже публиковался недавно. Новое сообщение не отправлено. Проверьте историю обсуждения.")
	case errors.Is(e, domain.ErrLinkLimit):
		failure(w, 429, "link_limit", "Сообщение не отправлено: слишком много ссылок для текущего лимита аккаунта. Сократите их количество.")
	case errors.Is(e, domain.ErrSafetyUnavailable):
		failure(w, 503, "safety_not_configured", "Контур безопасности временно не настроен. Данные не были сохранены.")
	default:
		slog.Error("database operation failed", "error_type", fmtErrorType(e))
		failure(w, 503, "temporarily_unavailable", "Сервис временно недоступен. Повторите позже.")
	}
}
func fmtErrorType(e error) string {
	if e == nil {
		return "none"
	}
	return "storage_error"
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	mt, _, e := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if e != nil || mt != "application/json" {
		failure(w, 415, "json_required", "Отправьте JSON.")
		return false
	}
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e = d.Decode(v); e != nil {
		failure(w, 400, "invalid_json", "Некорректный JSON или неподдерживаемое поле.")
		return false
	}
	if e = d.Decode(&struct{}{}); e != io.EOF {
		failure(w, 400, "invalid_json", "Ожидался один JSON-объект.")
		return false
	}
	return true
}
func token(r *http.Request) (string, bool) {
	a := r.Header.Get("Authorization")
	if !strings.HasPrefix(a, "Bearer ") {
		return "", false
	}
	t := strings.TrimPrefix(a, "Bearer ")
	b, e := base64.RawURLEncoding.DecodeString(t)
	return t, e == nil && len(b) == 32 && len(t) == 43
}
func (s *Server) user(w http.ResponseWriter, r *http.Request) (domain.User, bool) {
	t, ok := token(r)
	if !ok {
		fail(w, domain.ErrUnauthorized)
		return domain.User{}, false
	}
	u, e := s.DB.SessionUser(r.Context(), t)
	if e != nil {
		fail(w, e)
		return u, false
	}
	return u, true
}
func (s *Server) optionalUser(w http.ResponseWriter, r *http.Request) (string, bool) {
	if r.Header.Get("Authorization") == "" {
		return "", true
	}
	u, ok := s.user(w, r)
	return u.ID, ok
}
func textValid(x string, min, max int) bool {
	n := utf8.RuneCountInString(x)
	return utf8.ValidString(x) && n >= min && n <= max && !strings.ContainsRune(x, '\x00')
}
func clientKey(x string) bool {
	if len(x) < 16 || len(x) > 128 {
		return false
	}
	for _, c := range x {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func (s *Server) regions(w http.ResponseWriter, r *http.Request) {
	x, e := s.DB.Regions(r.Context())
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
func (s *Server) routes(w http.ResponseWriter, r *http.Request) {
	limit := 30
	if q := r.URL.Query().Get("limit"); q != "" {
		v, e := strconv.Atoi(q)
		if e != nil || v < 1 || v > 100 {
			fail(w, domain.ErrInvalid)
			return
		}
		limit = v
	}
	x, e := s.DB.Routes(r.Context(), r.URL.Query().Get("region"), r.URL.Query().Get("cursor"), limit)
	if e != nil {
		fail(w, e)
		return
	}
	data, e := routePageJSON(x, limit)
	routeResponse(w, data, e)
}
func (s *Server) route(w http.ResponseWriter, r *http.Request) {
	x, e := s.DB.Route(r.Context(), r.PathValue("id"))
	if e != nil {
		fail(w, e)
		return
	}
	data, e := routeDetailJSON(x)
	routeResponse(w, data, e)
}
func (s *Server) departures(w http.ResponseWriter, r *http.Request) {
	u, ok := s.optionalUser(w, r)
	if !ok {
		return
	}
	x, e := s.DB.Departures(r.Context(), r.URL.Query().Get("route"), u)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
func (s *Server) departure(w http.ResponseWriter, r *http.Request) {
	u, ok := s.optionalUser(w, r)
	if !ok {
		return
	}
	x, e := s.DB.Departure(r.Context(), r.PathValue("id"), u)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
func (s *Server) createDeparture(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	var in store.CreateDeparture
	if !decode(w, r, &in) {
		return
	}
	x, e := s.DB.CreateDeparture(r.Context(), u.ID, in)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 201, x)
}

func (s *Server) authGuard(w http.ResponseWriter, r *http.Request) bool {
	if !s.allowAuthAttempt(w, r, store.AuthIPScope, s.clientIP(r)) {
		return false
	}
	select {
	case s.authSlots <- struct{}{}:
		return true
	default:
		failure(w, 429, "auth_busy", "Повторите через несколько секунд.")
		return false
	}
}

func (s *Server) allowAuthAttempt(w http.ResponseWriter, r *http.Request, scope, identifier string) bool {
	key := auth.RateIdentity(s.cfg.AuthRateKey, scope, identifier)
	decision, err := s.authBudget.ConsumeAuthAttempt(r.Context(), scope, key)
	if err != nil {
		fail(w, err)
		return false
	}
	if !decision.Allowed {
		w.Header().Set("Retry-After", strconv.Itoa(decision.RetryAfter))
		failure(w, 429, "rate_limited", "Повторите через минуту.")
		return false
	}
	return true
}
func (s *Server) session(w http.ResponseWriter, r *http.Request, u domain.User, status int, credentialHash string) {
	t, e := auth.SessionToken()
	if e != nil {
		fail(w, e)
		return
	}
	exp := time.Now().UTC().Add(24 * time.Hour)
	if e = s.DB.CreateSessionWithCredentials(r.Context(), u.ID, t, exp, credentialHash); e != nil {
		fail(w, e)
		return
	}
	respond(w, status, map[string]any{"token": t, "expiresAt": exp, "user": u})
}
func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	if !s.authGuard(w, r) {
		return
	}
	defer func() { <-s.authSlots }()
	var in struct {
		Email       string `json:"email"`
		Password    string `json:"password"`
		DisplayName string `json:"displayName"`
		Role        string `json:"role"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Email = strings.ToLower(strings.TrimSpace(in.Email))
	in.DisplayName = strings.TrimSpace(in.DisplayName)
	a, e := mail.ParseAddress(in.Email)
	if e != nil || a.Address != in.Email || len(in.Email) > 254 || !textValid(in.DisplayName, 2, 80) || (in.Role != "tourist" && in.Role != "guide") {
		fail(w, domain.ErrInvalid)
		return
	}
	hash, e := auth.HashPassword(in.Password)
	if e != nil {
		fail(w, domain.ErrInvalid)
		return
	}
	u, e := s.registerWithMail(r.Context(), in.Email, hash, in.DisplayName, in.Role)
	if e != nil {
		accountLifecycleFailure(w, e)
		return
	}
	s.session(w, r, u, 201, hash)
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.authGuard(w, r) {
		return
	}
	defer func() { <-s.authSlots }()
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Email = strings.ToLower(strings.TrimSpace(in.Email))
	if len(in.Email) > 254 || len(in.Password) > 512 {
		fail(w, domain.ErrUnauthorized)
		return
	}
	if !s.allowAuthAttempt(w, r, store.LoginAccountScope, in.Email) {
		return
	}
	id, hash, e := s.DB.Credentials(r.Context(), in.Email)
	if errors.Is(e, domain.ErrNotFound) {
		_ = auth.VerifyPassword(s.dummyHash, in.Password)
		fail(w, domain.ErrUnauthorized)
		return
	}
	if e != nil {
		fail(w, e)
		return
	}
	if !auth.VerifyPassword(hash, in.Password) {
		fail(w, domain.ErrUnauthorized)
		return
	}
	u, e := s.DB.User(r.Context(), id)
	if e != nil {
		fail(w, e)
		return
	}
	s.session(w, r, u, 200, hash)
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.user(w, r); !ok {
		return
	}
	t, _ := token(r)
	if e := s.DB.RevokeSession(r.Context(), t); e != nil {
		fail(w, e)
		return
	}
	w.WriteHeader(204)
}
func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if ok {
		respond(w, 200, u)
	}
}
func (s *Server) profile(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	var in struct {
		DisplayName string `json:"displayName"`
		Role        string `json:"role"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.DisplayName = strings.TrimSpace(in.DisplayName)
	if !textValid(in.DisplayName, 2, 80) || (in.Role != "" && in.Role != "guide" && in.Role != "tourist") {
		fail(w, domain.ErrInvalid)
		return
	}
	x, e := s.DB.UpdateProfile(r.Context(), u.ID, in.DisplayName, in.Role)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}

func (s *Server) join(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if !clientKey(key) {
		failure(w, 400, "idempotency_key_required", "Нужен уникальный ключ действия.")
		return
	}
	var in struct {
		ExpectedVersion int64 `json:"expectedVersion"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.ExpectedVersion < 0 {
		fail(w, domain.ErrInvalid)
		return
	}
	x, e := s.DB.Join(r.Context(), u.ID, r.PathValue("id"), key, in.ExpectedVersion)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
func (s *Server) leave(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	x, e := s.DB.Mutate(r.Context(), u.ID, r.PathValue("id"), "leave", "", 0)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
func (s *Server) checkIn(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	var in struct {
		UserID          string `json:"userId"`
		ExpectedVersion int64  `json:"expectedVersion"`
	}
	if !decode(w, r, &in) {
		return
	}
	x, e := s.DB.Mutate(r.Context(), u.ID, r.PathValue("id"), "check-in", in.UserID, in.ExpectedVersion)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
func (s *Server) transition(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	var in struct {
		Action          string `json:"action"`
		ExpectedVersion int64  `json:"expectedVersion"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Action != "start" && in.Action != "complete" && in.Action != "abort" && in.Action != "cancel" {
		fail(w, domain.ErrInvalid)
		return
	}
	x, e := s.DB.Mutate(r.Context(), u.ID, r.PathValue("id"), in.Action, "", in.ExpectedVersion)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}

func (s *Server) messages(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	after := time.Time{}
	afterID := ""
	if c := r.URL.Query().Get("cursor"); c != "" {
		b, e := base64.RawURLEncoding.DecodeString(c)
		p := strings.Split(string(b), "|")
		if e != nil || len(p) != 2 {
			fail(w, domain.ErrInvalid)
			return
		}
		after, e = time.Parse(time.RFC3339Nano, p[0])
		if e != nil {
			fail(w, domain.ErrInvalid)
			return
		}
		afterID = p[1]
	} else if a := r.URL.Query().Get("after"); a != "" {
		t, e := time.Parse(time.RFC3339Nano, a)
		if e != nil {
			fail(w, domain.ErrInvalid)
			return
		}
		after = t
	}
	x, e := s.DB.Messages(r.Context(), u.ID, r.PathValue("id"), after, afterID)
	if e != nil {
		fail(w, e)
		return
	}
	meta := map[string]string{"mode": "production"}
	if len(x) > 0 {
		last := x[len(x)-1]
		meta["nextCursor"] = base64.RawURLEncoding.EncodeToString([]byte(last.CreatedAt.Format(time.RFC3339Nano) + "|" + last.ID))
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"data": x, "meta": meta})
}
func (s *Server) sendMessage(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	var in struct {
		Body     string `json:"body"`
		ClientID string `json:"clientId"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Body = strings.TrimSpace(in.Body)
	if !textValid(in.Body, 1, 4000) || !clientKey(in.ClientID) {
		fail(w, domain.ErrInvalid)
		return
	}
	x, e := s.DB.SendMessage(r.Context(), u.ID, r.PathValue("id"), in.Body, in.ClientID)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 201, x)
}
func (s *Server) reviews(w http.ResponseWriter, r *http.Request) {
	x, e := s.DB.Reviews(r.Context(), r.PathValue("id"))
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
func (s *Server) review(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	var in struct {
		Target string `json:"target"`
		Rating int    `json:"rating"`
		Body   string `json:"body"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Body = strings.TrimSpace(in.Body)
	if !textValid(in.Body, 1, 3000) || in.Rating < 1 || in.Rating > 5 || (in.Target != "route" && in.Target != "guide") {
		fail(w, domain.ErrInvalid)
		return
	}
	x, e := s.DB.CreateReview(r.Context(), u.ID, r.PathValue("id"), in.Target, in.Body, in.Rating)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 201, x)
}
func (s *Server) observations(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	var in struct {
		Observations []domain.Observation `json:"observations"`
	}
	if !decode(w, r, &in) {
		return
	}
	if len(in.Observations) < 1 || len(in.Observations) > 50 {
		fail(w, domain.ErrInvalid)
		return
	}
	for _, o := range in.Observations {
		if !clientKey(o.ClientID) || o.BaseVersion < 1 || !textValid(o.Body, 1, 4000) || (o.Kind != "field_note" && o.Kind != "check_in_observation") {
			fail(w, domain.ErrInvalid)
			return
		}
	}
	out := []domain.SyncAck{}
	for _, o := range in.Observations {
		ack, e := s.DB.RecordObservation(r.Context(), u.ID, o)
		if e != nil {
			fail(w, e)
			return
		}
		out = append(out, ack)
	}
	respond(w, 200, out)
}
