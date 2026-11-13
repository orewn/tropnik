package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestAccountMailConfigurationFailsClosedWithoutFallback(t *testing.T) {
	config := map[string]string{}
	read := func(key string) string { return config[key] }
	cfg, err := accountLifecycleConfig(read)
	if err != nil || cfg != nil {
		t.Fatal("empty environment must disable public registration", err)
	}
	config["TROPA_ACCOUNT_MAIL_KEY"] = strings.Repeat("ab", 32)
	if cfg, err = accountLifecycleConfig(read); err != nil || cfg != nil {
		t.Fatal("a decryption key alone must not enable registration or SMTP", err)
	}
	config["TROPA_SMTP_HOST"] = "mail.example.invalid"
	if _, err = accountLifecycleConfig(read); err == nil {
		t.Fatal("partial config accepted")
	}
	config = map[string]string{"TROPA_SMTP_HOST": "mail.example.invalid", "TROPA_SMTP_PORT": "465", "TROPA_SMTP_TLS_MODE": "tls", "TROPA_MAIL_FROM": "accounts@example.invalid", "TROPA_ACCOUNT_ACTION_URL": "https://tropnik.example/account/action"}
	if _, err = accountLifecycleConfig(read); err == nil {
		t.Fatal("SMTP without a separately provisioned mail key was accepted")
	}
	config["TROPA_ACCOUNT_MAIL_KEY"] = strings.Repeat("ab", 32)
	if cfg, err = accountLifecycleConfig(read); err != nil || cfg == nil || cfg.Mailer == nil || !bytes.Equal(cfg.MailKey, bytes.Repeat([]byte{0xab}, 32)) {
		t.Fatal("complete configuration rejected", err)
	}
	for key, value := range map[string]string{"TROPA_SMTP_TLS_MODE": "plaintext", "TROPA_SMTP_PORT": "0", "TROPA_MAIL_FROM": "accounts@example.invalid\r\nBcc: attacker@example.invalid", "TROPA_ACCOUNT_ACTION_URL": "http://tropnik.example/account/action", "TROPA_ACCOUNT_MAIL_KEY": "PRIVATE-INVALID-FIXTURE"} {
		old := config[key]
		config[key] = value
		if _, err = accountLifecycleConfig(read); err == nil {
			t.Fatalf("unsafe %s accepted", key)
		}
		if key == "TROPA_ACCOUNT_MAIL_KEY" && strings.Contains(err.Error(), value) {
			t.Fatal("mail key appeared in diagnostics")
		}
		config[key] = old
	}
	for _, endpoint := range []string{"https://пример.рф/account/action", "https://[::1]/account/action", "https://bad_host.invalid/account/action"} {
		config["TROPA_ACCOUNT_ACTION_URL"] = endpoint
		if _, err = accountLifecycleConfig(read); err == nil {
			t.Fatal("an unusable SMTP Message-ID hostname passed startup validation")
		}
	}
	config["TROPA_ACCOUNT_ACTION_URL"] = "https://tropnik.example/account/action"
	config["TROPA_SMTP_USERNAME"] = "account-mailer"
	if _, err = accountLifecycleConfig(read); err == nil {
		t.Fatal("partial SMTP credentials accepted")
	}
}
