package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/mail"
	"strings"
	"sync"
	"time"

	"tropa/backend/internal/auth"
	"tropa/backend/internal/domain"
	"tropa/backend/internal/store"
)

type AccountLifecycleConfig struct {
	Mailer    auth.AccountMailer
	ActionURL string
}

var errAccountMailUnavailable = errors.New("account mail unavailable")

func validateAccountLifecycleConfig(cfg *AccountLifecycleConfig) error {
	if cfg == nil {
		return nil
	}
	if cfg.Mailer == nil {
		return errors.New("account lifecycle requires a mail transport")
	}
	_, err := auth.AccountActionURL(cfg.ActionURL, store.VerifyEmailAction, strings.Repeat("A", 43))
	return err
}

type accountLifecycleStore interface {
	Register(context.Context, string, string, string, string) (domain.User, error)
	Credentials(context.Context, string) (string, string, error)
	IssueAccountAction(context.Context, string, string, [32]byte) (store.AccountActionRecipient, error)
	RevokeAccountAction(context.Context, [32]byte) error
	VerifyAccountEmail(context.Context, [32]byte) error
	ResetAccountPassword(context.Context, [32]byte, string) (store.AccountActionRecipient, error)
	DeleteAccount(context.Context, string, string) error
	RecordAccountMail(context.Context, string, string, bool) error
}

type accountMailJob struct {
	email   string
	purpose string
	userID  string // only for the notification after a successful reset
}

// Only bounded, short-lived email requests live in memory. There is deliberately
// no plaintext-token outbox. A process restart can lose pending mail; the user
// can request a new link. HTTP responses describe acceptance, never delivery.
type accountLifecycle struct {
	db     accountLifecycleStore
	cfg    *AccountLifecycleConfig
	jobs   chan accountMailJob
	slots  chan struct{}
	mu     sync.Mutex
	closed bool
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
}

func newAccountLifecycle(db accountLifecycleStore, cfg *AccountLifecycleConfig) (*accountLifecycle, error) {
	if err := validateAccountLifecycleConfig(cfg); err != nil {
		return nil, err
	}
	a := &accountLifecycle{db: db, cfg: cfg}
	if cfg == nil {
		return a, nil
	}
	copy := *cfg
	a.cfg = &copy
	a.jobs = make(chan accountMailJob, 36)
	a.slots = make(chan struct{}, 36)
	a.ctx, a.cancel = context.WithCancel(context.Background())
	a.done = make(chan struct{})
	var workers sync.WaitGroup
	for i := 0; i < 4; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for job := range a.jobs {
				a.deliver(job)
				<-a.slots
			}
		}()
	}
	go func() { workers.Wait(); close(a.done) }()
	return a, nil
}

func (a *accountLifecycle) reserve() bool {
	if a == nil || a.cfg == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return false
	}
	select {
	case a.slots <- struct{}{}:
		return true
	default:
		return false
	}
}

func (a *accountLifecycle) enqueueReserved(job accountMailJob) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		<-a.slots
		return false
	}
	a.jobs <- job // capacity is reserved before account creation or lookups
	return true
}

func (a *accountLifecycle) enqueue(job accountMailJob) bool {
	return a.reserve() && a.enqueueReserved(job)
}

func (a *accountLifecycle) shutdown(ctx context.Context) error {
	if a == nil || a.cfg == nil {
		return nil
	}
	a.mu.Lock()
	if !a.closed {
		a.closed = true
		close(a.jobs)
	}
	a.mu.Unlock()
	select {
	case <-a.done:
		a.cancel()
		return nil
	case <-ctx.Done():
		a.cancel()
		return ctx.Err()
	}
}

// Shutdown drains accepted email work within the caller's deadline. It belongs
// after HTTP shutdown, so no new requests race normal worker shutdown.
func (s *Server) Shutdown(ctx context.Context) error { return s.lifecycle.shutdown(ctx) }

func (a *accountLifecycle) deliver(job accountMailJob) {
	ctx, cancel := context.WithTimeout(a.ctx, 20*time.Second)
	defer cancel()
	var message auth.AccountMail
	var recipient store.AccountActionRecipient
	var digest [32]byte
	if job.purpose == "password_changed" {
		recipient = store.AccountActionRecipient{ID: job.userID, Email: job.email}
		message = auth.AccountMail{To: job.email, Subject: "Пароль Tropnik изменён", Text: "Пароль вашего аккаунта Tropnik изменён. Все прежние сессии и ссылки восстановления отозваны. Войдите заново с новым паролем. Если это были не вы, откройте Tropnik самостоятельно и запросите восстановление доступа."}
	} else {
		raw, hash, err := auth.AccountActionToken()
		if err != nil {
			slog.Warn("account token generation failed")
			return
		}
		digest = hash
		recipient, err = a.db.IssueAccountAction(ctx, job.email, job.purpose, digest)
		if errors.Is(err, domain.ErrNotFound) {
			return
		}
		if err != nil {
			slog.Warn("account mail request preparation failed")
			return
		}
		link, err := auth.AccountActionURL(a.cfg.ActionURL, job.purpose, raw)
		if err != nil {
			a.mailResult(recipient.ID, job.purpose, digest, false)
			return
		}
		message = auth.AccountMail{To: recipient.Email, Subject: "Подтвердите почту Tropnik", Text: "Подтвердите адрес электронной почты для аккаунта Tropnik. Ссылка действует 24 часа и только один раз:\n\n" + link + "\n\nЕсли вы не создавали аккаунт, не переходите по ссылке. Для дальнейших действий потребуется пароль аккаунта."}
		if job.purpose == store.ResetPasswordAction {
			message.Subject = "Восстановление доступа к Tropnik"
			message.Text = "Для установки нового пароля Tropnik откройте ссылку. Она действует 30 минут и только один раз:\n\n" + link + "\n\nЕсли вы не запрашивали восстановление, ничего не меняйте. Ваш текущий пароль продолжает действовать."
		}
	}
	err := a.cfg.Mailer.Send(ctx, message)
	a.mailResult(recipient.ID, job.purpose, digest, err == nil)
}

func (a *accountLifecycle) mailResult(user, purpose string, digest [32]byte, accepted bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !accepted && purpose != "password_changed" {
		if err := a.db.RevokeAccountAction(ctx, digest); err != nil {
			slog.Warn("failed account mail token revocation unavailable")
		}
	}
	if err := a.db.RecordAccountMail(ctx, user, purpose, accepted); err != nil {
		slog.Warn("account mail audit unavailable")
	}
	if !accepted {
		slog.Warn("account mail transport did not confirm acceptance")
	}
}

func (s *Server) registerWithMail(ctx context.Context, email, hash, name, role string) (domain.User, error) {
	if !s.lifecycle.reserve() {
		return domain.User{}, errAccountMailUnavailable
	}
	u, err := s.lifecycle.db.Register(ctx, email, hash, name, role)
	if err != nil {
		<-s.lifecycle.slots
		return u, err
	}
	if !s.lifecycle.enqueueReserved(accountMailJob{email: email, purpose: store.VerifyEmailAction}) {
		return u, errAccountMailUnavailable
	}
	return u, nil
}

func accountLifecycleFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errAccountMailUnavailable):
		failure(w, 503, "registration_unavailable", "Сейчас не удаётся отправлять письма. Регистрация и новые ссылки временно недоступны. Попробуйте позже. В существующий аккаунт можно войти.")
	case errors.Is(err, store.ErrAccountAction):
		failure(w, 400, "account_link_invalid", "Ссылка недействительна или уже использована. Запросите новую.")
	case errors.Is(err, store.ErrActiveAccount):
		failure(w, 409, "account_has_active_trips", "Сначала завершите участие в текущих походах и закройте свои открытые заявки. Назначенному гиду нужно завершить или отменить выход.")
	default:
		fail(w, err)
	}
}

func (s *Server) accountLifecycleRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/v1/auth/email/request", s.requestEmailVerification)
	m.HandleFunc("POST /api/v1/auth/email/confirm", s.confirmEmail)
	m.HandleFunc("POST /api/v1/auth/password/request", s.requestPasswordReset)
	m.HandleFunc("POST /api/v1/auth/password/reset", s.resetPassword)
	m.HandleFunc("POST /api/v1/me/delete", s.deleteAccount)
}

func (s *Server) requestEmailVerification(w http.ResponseWriter, r *http.Request) {
	s.requestAccountMail(w, r, store.VerifyEmailAction)
}
func (s *Server) requestPasswordReset(w http.ResponseWriter, r *http.Request) {
	s.requestAccountMail(w, r, store.ResetPasswordAction)
}

func (s *Server) requestAccountMail(w http.ResponseWriter, r *http.Request, purpose string) {
	if !s.authGuard(w, r) {
		return
	}
	defer func() { <-s.authSlots }()
	var in struct {
		Email string `json:"email"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Email = strings.ToLower(strings.TrimSpace(in.Email))
	address, err := mail.ParseAddress(in.Email)
	if err != nil || address.Address != in.Email || len(in.Email) > 254 {
		fail(w, domain.ErrInvalid)
		return
	}
	if s.lifecycle == nil || s.lifecycle.cfg == nil {
		accountLifecycleFailure(w, errAccountMailUnavailable)
		return
	}
	// All syntactically valid addresses take the same DB rate-limit path. Neither
	// account lookup nor SMTP latency is part of the request's response timing.
	key := auth.RateIdentity(s.cfg.AuthRateKey, store.AccountMailScope, in.Email)
	decision, err := s.authBudget.ConsumeAuthAttempt(r.Context(), store.AccountMailScope, key)
	if err != nil {
		fail(w, err)
		return
	}
	if decision.Allowed && !s.lifecycle.enqueue(accountMailJob{email: in.Email, purpose: purpose}) {
		accountLifecycleFailure(w, errAccountMailUnavailable)
		return
	}
	respond(w, 202, map[string]string{"status": "accepted", "message": "Если адрес подходит для этого действия, мы попытаемся отправить ссылку. Проверьте входящие и спам. Повторный запрос может быть временно ограничен."})
}

func (s *Server) confirmEmail(w http.ResponseWriter, r *http.Request) {
	if !s.authGuard(w, r) {
		return
	}
	defer func() { <-s.authSlots }()
	var in struct {
		Token string `json:"token"`
	}
	if !decode(w, r, &in) {
		return
	}
	digest, err := auth.AccountActionDigest(in.Token)
	if err != nil {
		accountLifecycleFailure(w, store.ErrAccountAction)
		return
	}
	if err = s.lifecycle.db.VerifyAccountEmail(r.Context(), digest); err != nil {
		accountLifecycleFailure(w, err)
		return
	}
	respond(w, 200, map[string]string{"status": "verified"})
}

func (s *Server) resetPassword(w http.ResponseWriter, r *http.Request) {
	if !s.authGuard(w, r) {
		return
	}
	defer func() { <-s.authSlots }()
	var in struct {
		Token                string `json:"token"`
		Password             string `json:"password"`
		PasswordConfirmation string `json:"passwordConfirmation"`
	}
	if !decode(w, r, &in) {
		return
	}
	digest, err := auth.AccountActionDigest(in.Token)
	if err != nil {
		accountLifecycleFailure(w, store.ErrAccountAction)
		return
	}
	if in.Password != in.PasswordConfirmation {
		fail(w, domain.ErrInvalid)
		return
	}
	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		fail(w, domain.ErrInvalid)
		return
	}
	user, err := s.lifecycle.db.ResetAccountPassword(r.Context(), digest, hash)
	if err != nil {
		accountLifecycleFailure(w, err)
		return
	}
	if !s.lifecycle.enqueue(accountMailJob{email: user.Email, userID: user.ID, purpose: "password_changed"}) {
		slog.Warn("password reset notification could not be queued")
	}
	respond(w, 200, map[string]string{"status": "password_changed", "message": "Пароль изменён. Вы вышли из аккаунта на всех устройствах. Войдите заново."})
}

func (s *Server) deleteAccount(w http.ResponseWriter, r *http.Request) {
	user, ok := s.user(w, r)
	if !ok {
		return
	}
	if !s.authGuard(w, r) {
		return
	}
	defer func() { <-s.authSlots }()
	if !s.allowAuthAttempt(w, r, store.AccountReauthScope, user.ID) {
		return
	}
	var in struct {
		Password     string `json:"password"`
		Confirmation string `json:"confirmation"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Confirmation != "delete" || len(in.Password) > 512 {
		fail(w, domain.ErrInvalid)
		return
	}
	if user.StaffRole != "none" {
		failure(w, 403, "staff_account_managed", "Служебный доступ сначала должен закрыть оператор сервиса.")
		return
	}
	id, hash, err := s.lifecycle.db.Credentials(r.Context(), user.Email)
	if err != nil || id != user.ID {
		if errors.Is(err, domain.ErrNotFound) {
			err = domain.ErrUnauthorized
		}
		if err == nil {
			err = domain.ErrUnauthorized
		}
		accountLifecycleFailure(w, err)
		return
	}
	if !auth.VerifyPassword(hash, in.Password) {
		failure(w, 403, "reauthentication_failed", "Не удалось подтвердить текущий пароль.")
		return
	}
	if err = s.lifecycle.db.DeleteAccount(r.Context(), user.ID, hash); err != nil {
		accountLifecycleFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
