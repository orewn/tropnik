package main

import (
	"errors"
	"strconv"
	"strings"

	"tropa/backend/internal/auth"
	"tropa/backend/internal/httpapi"
)

// No environment configuration means public registration and new mail links
// stay closed. There is no development log mailer or token-return shortcut.
func accountLifecycleConfig(getenv func(string) string) (*httpapi.AccountLifecycleConfig, error) {
	keys := []string{"TROPA_SMTP_HOST", "TROPA_SMTP_PORT", "TROPA_SMTP_TLS_MODE", "TROPA_SMTP_USERNAME", "TROPA_SMTP_PASSWORD", "TROPA_MAIL_FROM", "TROPA_ACCOUNT_ACTION_URL"}
	configured := false
	for _, key := range keys {
		if getenv(key) != "" {
			configured = true
		}
	}
	if !configured {
		return nil, nil
	}
	port, err := strconv.Atoi(getenv("TROPA_SMTP_PORT"))
	if err != nil {
		return nil, errors.New("TROPA_SMTP_PORT must be a valid port")
	}
	mailer, err := auth.NewSMTPMailer(auth.SMTPConfig{Host: getenv("TROPA_SMTP_HOST"), Port: port, TLSMode: getenv("TROPA_SMTP_TLS_MODE"), Username: getenv("TROPA_SMTP_USERNAME"), Password: getenv("TROPA_SMTP_PASSWORD"), From: getenv("TROPA_MAIL_FROM")})
	if err != nil {
		return nil, err
	}
	actionURL := getenv("TROPA_ACCOUNT_ACTION_URL")
	if _, err = auth.AccountActionURL(actionURL, "verify_email", strings.Repeat("A", 43)); err != nil {
		return nil, err
	}
	return &httpapi.AccountLifecycleConfig{Mailer: mailer, ActionURL: actionURL}, nil
}
