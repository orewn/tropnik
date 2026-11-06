package main

import "testing"

func TestAccountMailConfigurationFailsClosedWithoutFallback(t *testing.T) {
	config := map[string]string{}
	read := func(key string) string { return config[key] }
	cfg, err := accountLifecycleConfig(read)
	if err != nil || cfg != nil {
		t.Fatal("empty environment must disable public registration", err)
	}
	config["TROPA_SMTP_HOST"] = "mail.example.invalid"
	if _, err = accountLifecycleConfig(read); err == nil {
		t.Fatal("partial config accepted")
	}
	config = map[string]string{"TROPA_SMTP_HOST": "mail.example.invalid", "TROPA_SMTP_PORT": "465", "TROPA_SMTP_TLS_MODE": "tls", "TROPA_MAIL_FROM": "accounts@example.invalid", "TROPA_ACCOUNT_ACTION_URL": "https://tropnik.example/account/action"}
	if cfg, err = accountLifecycleConfig(read); err != nil || cfg == nil || cfg.Mailer == nil {
		t.Fatal("complete configuration rejected", err)
	}
	for key, value := range map[string]string{"TROPA_SMTP_TLS_MODE": "plaintext", "TROPA_SMTP_PORT": "0", "TROPA_MAIL_FROM": "accounts@example.invalid\r\nBcc: attacker@example.invalid", "TROPA_ACCOUNT_ACTION_URL": "http://tropnik.example/account/action"} {
		old := config[key]
		config[key] = value
		if _, err = accountLifecycleConfig(read); err == nil {
			t.Fatalf("unsafe %s accepted", key)
		}
		config[key] = old
	}
	config["TROPA_SMTP_USERNAME"] = "account-mailer"
	if _, err = accountLifecycleConfig(read); err == nil {
		t.Fatal("partial SMTP credentials accepted")
	}
}
