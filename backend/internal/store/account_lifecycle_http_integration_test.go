//go:build integration

package store_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"tropa/backend/internal/auth"
	"tropa/backend/internal/httpapi"
)

type capturedAccountMailer struct{ messages chan auth.AccountMail }

func (m capturedAccountMailer) Send(ctx context.Context, mail auth.AccountMail) error {
	select {
	case m.messages <- mail:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func lifecycleJSON(t *testing.T, handler http.Handler, path string, input any, session string) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/"+path, strings.NewReader(string(data)))
	r.Header.Set("Content-Type", "application/json")
	if session != "" {
		r.Header.Set("Authorization", "Bearer "+session)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func lifecycleSession(t *testing.T, w *httptest.ResponseRecorder, want int) string {
	t.Helper()
	var body struct {
		Data struct {
			Token string
			User  struct {
				ID            string
				EmailVerified bool
			}
		}
	}
	if w.Code != want {
		t.Fatal("auth response", w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.Data.Token == "" || body.Data.User.ID == "" {
		t.Fatal("missing original session envelope", err)
	}
	return body.Data.Token
}

func emailedAction(t *testing.T, mailer capturedAccountMailer, purpose string) string {
	t.Helper()
	select {
	case message := <-mailer.messages:
		for _, field := range strings.Fields(message.Text) {
			if !strings.HasPrefix(field, "https://") {
				continue
			}
			link, err := url.Parse(field)
			if err != nil {
				t.Fatal(err)
			}
			fragment, err := url.ParseQuery(link.Fragment)
			if err != nil {
				t.Fatal(err)
			}
			if link.Host != "tropnik.example" || link.RawQuery != "" || fragment.Get("action") != purpose {
				t.Fatal("unsafe mail link")
			}
			if _, err := auth.AccountActionDigest(fragment.Get("token")); err != nil {
				t.Fatal(err)
			}
			return fragment.Get("token")
		}
		t.Fatal("missing mail action")
	case <-time.After(5 * time.Second):
		t.Fatal("test mail not received")
	}
	return ""
}

func TestPublicLifecycleHTTPRoundTripWithExplicitTestMailer(t *testing.T) {
	s := db(t)
	config := httpapi.Config{AuthRateKey: make([]byte, 32)}
	closed, err := httpapi.New(s, config)
	if err != nil {
		t.Fatal(err)
	}
	input := map[string]string{"email": "lifecycle-http@example.invalid", "password": "old private fixture password", "displayName": "Lifecycle fixture", "role": "tourist"}
	if response := lifecycleJSON(t, closed.Handler(), "auth/register", input, ""); response.Code != 503 {
		t.Fatal("registration opened without mail transport", response.Code, response.Body.String())
	}
	var created int
	if err := s.Pool.QueryRow(context.Background(), "SELECT count(*) FROM users WHERE email=$1", input["email"]).Scan(&created); err != nil || created != 0 {
		t.Fatal("closed signup created an account", err)
	}
	mailer := capturedAccountMailer{messages: make(chan auth.AccountMail, 8)}
	config.AccountLifecycle = &httpapi.AccountLifecycleConfig{Mailer: mailer, ActionURL: "https://tropnik.example/account/action"}
	app, err := httpapi.New(s, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	handler := app.Handler()
	registered := lifecycleJSON(t, handler, "auth/register", input, "")
	session := lifecycleSession(t, registered, 201)
	verification := emailedAction(t, mailer, "verify_email")
	if strings.Contains(registered.Body.String(), verification) {
		t.Fatal("verification secret returned in API")
	}
	confirmed := lifecycleJSON(t, handler, "auth/email/confirm", map[string]string{"token": verification}, "")
	if confirmed.Code != 200 {
		t.Fatal(confirmed.Code, confirmed.Body.String())
	}
	if replay := lifecycleJSON(t, handler, "auth/email/confirm", map[string]string{"token": verification}, ""); replay.Code != 400 {
		t.Fatal("verification replay", replay.Code)
	}
	known := lifecycleJSON(t, handler, "auth/password/request", map[string]string{"email": input["email"]}, "")
	unknown := lifecycleJSON(t, handler, "auth/password/request", map[string]string{"email": "absent@example.invalid"}, "")
	if known.Code != 202 || known.Body.String() != unknown.Body.String() {
		t.Fatal("recovery enumeration", known.Code, unknown.Code)
	}
	reset := emailedAction(t, mailer, "reset_password")
	if strings.Contains(known.Body.String(), reset) {
		t.Fatal("reset secret returned in API")
	}
	newPassword := "new private fixture password"
	changed := lifecycleJSON(t, handler, "auth/password/reset", map[string]string{"token": reset, "password": newPassword, "passwordConfirmation": newPassword}, "")
	if changed.Code != 200 {
		t.Fatal(changed.Code, changed.Body.String())
	}
	if _, err := s.SessionUser(context.Background(), session); err == nil {
		t.Fatal("old session survived HTTP reset")
	}
	if old := lifecycleJSON(t, handler, "auth/login", map[string]string{"email": input["email"], "password": input["password"]}, ""); old.Code != 401 {
		t.Fatal("old password still logs in", old.Code)
	}
	newSession := lifecycleSession(t, lifecycleJSON(t, handler, "auth/login", map[string]string{"email": input["email"], "password": newPassword}, ""), 200)
	denied := lifecycleJSON(t, handler, "me/delete", map[string]string{"password": "wrong password", "confirmation": "delete"}, newSession)
	if denied.Code != 403 {
		t.Fatal("deletion failed to reauthenticate", denied.Code)
	}
	if _, err := s.SessionUser(context.Background(), newSession); err != nil {
		t.Fatal("mistyped password revoked valid session", err)
	}
	deleted := lifecycleJSON(t, handler, "me/delete", map[string]string{"password": newPassword, "confirmation": "delete"}, newSession)
	if deleted.Code != 204 {
		t.Fatal(deleted.Code, deleted.Body.String())
	}
	if loggedIn := lifecycleJSON(t, handler, "auth/login", map[string]string{"email": input["email"], "password": newPassword}, ""); loggedIn.Code != 401 {
		t.Fatal("deleted account logged in", loggedIn.Code)
	}
}
