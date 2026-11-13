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
    Mailer auth.AccountMailer
    ActionURL string
    MailKey []byte
}

var errAccountMailUnavailable = errors.New("account mail unavailable")

func validateAccountLifecycleConfig(cfg *AccountLifecycleConfig) error {
    if cfg == nil { return nil }
    if cfg.Mailer == nil || len(cfg.MailKey) != 32 { return errors.New("account lifecycle requires a mail transport and independent encryption key") }
    if _, err := auth.AccountActionURL(cfg.ActionURL,store.VerifyEmailAction,strings.Repeat("A",43)); err != nil { return err }
    _, err := auth.AccountMailMessageID("00000000-0000-4000-8000-000000000001",cfg.ActionURL)
    return err
}

type accountLifecycleStore interface {
    ConfigureAccountMail(context.Context,[]byte) error
    RegisterWithAccountMail(context.Context,string,string,string,string) (domain.User,error)
    QueueAccountMail(context.Context,string,string) error
    ClaimAccountMail(context.Context) (store.AccountMailLease,error)
    PrepareAccountMail(context.Context,store.AccountMailLease,string) (auth.AccountMail,error)
    FinishAccountMail(context.Context,store.AccountMailLease,bool) error
    PruneAccountMail(context.Context) error
    Credentials(context.Context,string) (string,string,error)
    VerifyAccountEmail(context.Context,[32]byte) error
    ResetAccountPasswordWithMail(context.Context,[32]byte,string) (store.AccountActionRecipient,error)
    DeleteAccount(context.Context,string,string) error
}

// Only wake-up hints live in memory. Every accepted job and prepared message is
// durable, encrypted, globally bounded, and recovered using fenced DB leases.
type accountLifecycle struct {
    db accountLifecycleStore
    cfg *AccountLifecycleConfig
    mu sync.Mutex
    closed bool
    ctx context.Context
    cancel context.CancelFunc
    done chan struct{}
    wake chan struct{}
}

func newAccountLifecycle(db accountLifecycleStore,cfg *AccountLifecycleConfig) (*accountLifecycle,error) {
    if err := validateAccountLifecycleConfig(cfg); err != nil { return nil,err }
    a:=&accountLifecycle{db:db,cfg:cfg}
    if db != nil {
        var key []byte
        if cfg != nil { key=cfg.MailKey }
        ctx,cancel:=context.WithTimeout(context.Background(),5*time.Second)
        err:=db.ConfigureAccountMail(ctx,key)
        cancel()
        if err!=nil { return nil,err }
    }
    if cfg==nil { return a,nil }
    if db==nil { return nil,errAccountMailUnavailable }
    copy:=*cfg
    copy.MailKey=nil
    a.cfg=&copy
    a.ctx,a.cancel=context.WithCancel(context.Background())
    a.done=make(chan struct{})
    a.wake=make(chan struct{},1)
    var workers sync.WaitGroup
    for i:=0;i<4;i++ {
        workers.Add(1)
        go func(prune bool) { defer workers.Done(); a.work(prune) }(i==0)
    }
    go func(){workers.Wait();close(a.done)}()
    return a,nil
}

func (a *accountLifecycle) available() bool {
    if a==nil || a.cfg==nil { return false }
    a.mu.Lock();defer a.mu.Unlock()
    return !a.closed
}

func (a *accountLifecycle) notify() { select { case a.wake<-struct{}{}: default: } }

func (a *accountLifecycle) work(prune bool) {
    nextPrune:=time.Now()
    nextWarning:=time.Time{}
    for {
        if a.ctx.Err()!=nil { return }
        if prune && time.Now().After(nextPrune) {
            ctx,cancel:=context.WithTimeout(a.ctx,5*time.Second)
            if err:=a.db.PruneAccountMail(ctx); err!=nil && a.ctx.Err()==nil { slog.Warn("account mail retention unavailable") }
            cancel()
            nextPrune=time.Now().Add(time.Minute)
        }
        ctx,cancel:=context.WithTimeout(a.ctx,5*time.Second)
        lease,err:=a.db.ClaimAccountMail(ctx)
        cancel()
        if err==nil { a.deliver(lease);continue }
        delay:=500*time.Millisecond
        if !errors.Is(err,domain.ErrNotFound) {
            delay=5*time.Second
            if a.ctx.Err()==nil && time.Now().After(nextWarning) {
                slog.Warn("durable account mail claim unavailable")
                nextWarning=time.Now().Add(30*time.Second)
            }
        }
        timer:=time.NewTimer(delay)
        select { case <-a.ctx.Done(): timer.Stop();return; case <-a.wake: timer.Stop(); case <-timer.C: }
    }
}

func (a *accountLifecycle) deliver(lease store.AccountMailLease) {
    ctx,cancel:=context.WithTimeout(a.ctx,20*time.Second)
    defer cancel()
    message,err:=a.db.PrepareAccountMail(ctx,lease,a.cfg.ActionURL)
    if err!=nil {
        if !errors.Is(err,domain.ErrNotFound) && a.ctx.Err()==nil { slog.Warn("durable account mail preparation unavailable") }
        // Preparation errors do not discard ciphertext. The lease expires and
        // a subsequent worker can recover; key/cipher errors remain visible.
        return
    }
    accepted:=a.cfg.Mailer.Send(ctx,message)==nil
    finishCtx,finishCancel:=context.WithTimeout(context.Background(),5*time.Second)
    defer finishCancel()
    if err=a.db.FinishAccountMail(finishCtx,lease,accepted);err!=nil { slog.Warn("durable account mail acknowledgement unavailable") }
    if !accepted && a.ctx.Err()==nil { slog.Warn("account mail transport did not confirm acceptance") }
}

func (a *accountLifecycle) shutdown(ctx context.Context) error {
    if a==nil || a.cfg==nil { return nil }
    a.mu.Lock();a.closed=true;a.cancel();a.mu.Unlock()
    select { case <-a.done:return nil;case <-ctx.Done():return ctx.Err() }
}

// Shutdown stops SMTP work; pending encrypted rows survive and are reclaimed by
// the next process. It belongs after HTTP shutdown so intake has stopped first.
func (s *Server) Shutdown(ctx context.Context) error { return s.lifecycle.shutdown(ctx) }

func (s *Server) registerWithMail(ctx context.Context,email,hash,name,role string) (domain.User,error) {
    if !s.lifecycle.available() { return domain.User{},errAccountMailUnavailable }
    user,err:=s.lifecycle.db.RegisterWithAccountMail(ctx,email,hash,name,role)
    if err==nil { s.lifecycle.notify() }
    return user,err
}

func accountLifecycleFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errAccountMailUnavailable), errors.Is(err, store.ErrAccountMailUnavailable), errors.Is(err, store.ErrAccountMailQueueFull):
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
	if !s.lifecycle.available() {
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
	if decision.Allowed {
        if err=s.lifecycle.db.QueueAccountMail(r.Context(),in.Email,purpose);err!=nil {
            accountLifecycleFailure(w,err)
            return
        }
        s.lifecycle.notify()
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
    if s.lifecycle==nil || s.lifecycle.db==nil || (s.lifecycle.cfg!=nil && !s.lifecycle.available()) {
        accountLifecycleFailure(w,errAccountMailUnavailable)
        return
    }
    _, err = s.lifecycle.db.ResetAccountPasswordWithMail(r.Context(), digest, hash)
	if err != nil {
		accountLifecycleFailure(w, err)
		return
	}
	s.lifecycle.notify()
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
