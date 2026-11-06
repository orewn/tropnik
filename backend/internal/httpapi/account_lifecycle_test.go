package httpapi

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"tropa/backend/internal/auth"
	"tropa/backend/internal/domain"
	"tropa/backend/internal/store"
)

type lifecycleFixture struct {
	mu         sync.Mutex
	issued     [][32]byte
	revoked    [][32]byte
	registered int
	completed  chan bool
}

func (f *lifecycleFixture) Register(_ context.Context, email, hash, name, role string) (domain.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.registered++
	return domain.User{ID: "test-account", Email: email, DisplayName: name, Role: role, StaffRole: "none"}, nil
}
func (f *lifecycleFixture) Credentials(context.Context, string) (string, string, error) {
	return "", "", domain.ErrNotFound
}
func (f *lifecycleFixture) IssueAccountAction(_ context.Context, email, purpose string, digest [32]byte) (store.AccountActionRecipient, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if email != "person@example.invalid" {
		return store.AccountActionRecipient{}, domain.ErrNotFound
	}
	f.issued = append(f.issued, digest)
	return store.AccountActionRecipient{ID: "test-account", Email: email}, nil
}
func (f *lifecycleFixture) RevokeAccountAction(_ context.Context, digest [32]byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.revoked = append(f.revoked, digest)
	return nil
}
func (f *lifecycleFixture) VerifyAccountEmail(context.Context, [32]byte) error {
	return store.ErrAccountAction
}
func (f *lifecycleFixture) ResetAccountPassword(context.Context, [32]byte, string) (store.AccountActionRecipient, error) {
	return store.AccountActionRecipient{}, store.ErrAccountAction
}
func (f *lifecycleFixture) DeleteAccount(context.Context, string, string) error {
	return domain.ErrUnauthorized
}
func (f *lifecycleFixture) RecordAccountMail(_ context.Context, _ string, _ string, accepted bool) error {
	if f.completed != nil {
		f.completed <- accepted
	}
	return nil
}

type lifecycleMailer func(context.Context, auth.AccountMail) error

func (m lifecycleMailer) Send(ctx context.Context, mail auth.AccountMail) error { return m(ctx, mail) }

func lifecycleServer(t *testing.T, mailer auth.AccountMailer) (*Server, *lifecycleFixture) {
	t.Helper()
	s := testServer(t, Config{AccountLifecycle: &AccountLifecycleConfig{Mailer: mailer, ActionURL: "https://tropnik.example/account/action"}})
	fixture := &lifecycleFixture{completed: make(chan bool, 40)}
	s.lifecycle.db = fixture
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = s.Shutdown(ctx)
	})
	return s, fixture
}

func lifecycleRequest(s *Server, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "/api/v1/"+path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}

func TestRegistrationIsClosedWithoutAnExplicitMailTransport(t *testing.T) {
	s := testServer(t, Config{})
	w := lifecycleRequest(s, "auth/register", `{"email":"person@example.invalid","password":"strong fixture password","displayName":"Test person","role":"tourist"}`)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "registration_unavailable") {
		t.Fatal(w.Code, w.Body.String())
	}
	// The server has no database in this test. A successful DB call would panic;
	// absence of the mail transport is checked before creating the account.
	if strings.Contains(w.Body.String(), "token") {
		t.Fatal("secret returned")
	}
}

func TestExplicitTestMailerAllowsLocalRegistrationWithoutNetworkDelivery(t *testing.T) {
	mail := make(chan auth.AccountMail, 1)
	s, f := lifecycleServer(t, lifecycleMailer(func(_ context.Context, m auth.AccountMail) error { mail <- m; return nil }))
	u, err := s.registerWithMail(context.Background(), "person@example.invalid", "test-hash", "Test person", "tourist")
	if err != nil || u.ID == "" || u.EmailVerified {
		t.Fatal(u, err)
	}
	select {
	case m := <-mail:
		if !strings.Contains(m.Text, "#action=verify_email&token=") {
			t.Fatal("missing fragment link")
		}
	case <-time.After(time.Second):
		t.Fatal("test mail not attempted")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.registered != 1 || len(f.issued) != 1 {
		t.Fatal("registration was not tied to a verification request")
	}
}

func TestRecoveryResponseDoesNotWaitForSMTPOrRevealAccountExistence(t *testing.T) {
	started := make(chan struct{}, 1)
	s, _ := lifecycleServer(t, lifecycleMailer(func(ctx context.Context, _ auth.AccountMail) error {
		started <- struct{}{}
		<-ctx.Done()
		return ctx.Err()
	}))
	a := lifecycleRequest(s, "auth/password/request", `{"email":"person@example.invalid"}`)
	b := lifecycleRequest(s, "auth/password/request", `{"email":"absent@example.invalid"}`)
	if a.Code != 202 || b.Code != 202 || a.Body.String() != b.Body.String() {
		t.Fatal("account enumeration through response", a.Code, b.Code)
	}
	if strings.Contains(a.Body.String(), "token") || strings.Contains(a.Body.String(), "test-account") {
		t.Fatal("account secret leaked")
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("delivery not started asynchronously")
	}
}

func TestPerAddressMailLimitKeepsTheUniformResponseAndDoesNotQueue(t *testing.T) {
	s, f := lifecycleServer(t, lifecycleMailer(func(context.Context, auth.AccountMail) error { t.Error("mail rate limit bypassed"); return nil }))
	s.authBudget = budgetFunc(func(_ context.Context, scope string, _ [32]byte) (store.AuthAttempt, error) {
		return store.AuthAttempt{Allowed: scope != store.AccountMailScope, RetryAfter: 900}, nil
	})
	w := lifecycleRequest(s, "auth/password/request", `{"email":"person@example.invalid"}`)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.issued) != 0 {
		t.Fatal("rate-limited token issued")
	}
}

func TestMailQueueIsBoundedAndShutdownRejectsMoreWork(t *testing.T) {
	s, _ := lifecycleServer(t, lifecycleMailer(func(ctx context.Context, _ auth.AccountMail) error { <-ctx.Done(); return ctx.Err() }))
	job := accountMailJob{email: "person@example.invalid", purpose: store.ResetPasswordAction}
	for i := 0; i < 36; i++ {
		if !s.lifecycle.enqueue(job) {
			t.Fatal("capacity smaller than documented", i)
		}
	}
	if s.lifecycle.enqueue(job) {
		t.Fatal("unbounded queue")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_ = s.Shutdown(ctx)
	if s.lifecycle.enqueue(job) {
		t.Fatal("work accepted after shutdown")
	}
}

func TestFailedMailRevokesOnlyItsDigestAndDoesNotExposeTransportDetails(t *testing.T) {
	s, f := lifecycleServer(t, lifecycleMailer(func(context.Context, auth.AccountMail) error {
		return errors.New("private SMTP recipient and credential diagnostic")
	}))
	w := lifecycleRequest(s, "auth/email/request", `{"email":"person@example.invalid"}`)
	if w.Code != 202 || strings.Contains(w.Body.String(), "private SMTP") {
		t.Fatal(w.Code, w.Body.String())
	}
	select {
	case accepted := <-f.completed:
		if accepted {
			t.Fatal("failed send claimed acceptance")
		}
	case <-time.After(time.Second):
		t.Fatal("failure not processed")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.issued) != 1 || len(f.revoked) != 1 || f.issued[0] != f.revoked[0] {
		t.Fatal("failed send left a usable link")
	}
}

func TestAccountActionMalformedAndSpentLinksShareSafeFailure(t *testing.T) {
	s, _ := lifecycleServer(t, lifecycleMailer(func(context.Context, auth.AccountMail) error { return nil }))
	for _, raw := range []string{"short", strings.Repeat("A", 43)} {
		w := lifecycleRequest(s, "auth/email/confirm", `{"token":"`+raw+`"}`)
		if w.Code != 400 || !strings.Contains(w.Body.String(), "account_link_invalid") || strings.Contains(w.Body.String(), raw) {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}
