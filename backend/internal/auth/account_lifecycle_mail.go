package auth

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type AccountMail struct {
	To        string
	Subject   string
	Text      string
	MessageID string
}

// AccountMailMessageID is created once when a durable job is prepared and is
// encrypted with its body. Retries must reuse it; SMTP acceptance can be lost
// after DATA even though the receiving server has already queued the message.
func AccountMailMessageID(jobID, actionURL string) (string, error) {
	if !canonicalAccountMailJobID(jobID) {
		return "", errors.New("invalid account mail job identifier")
	}
	if _, err := AccountActionURL(actionURL, "verify_email", strings.Repeat("A", 43)); err != nil {
		return "", errors.New("invalid account mail action URL")
	}
	u, _ := url.Parse(actionURL)
	value := "<tropnik-account-" + jobID + "@" + strings.ToLower(u.Hostname()) + ">"
	if !validAccountMailMessageID(value) {
		return "", errors.New("account mail action URL requires an ASCII DNS hostname")
	}
	return value, nil
}

func validAccountMailMessageID(value string) bool {
	if len(value) < 5 || len(value) > 320 || value[0] != '<' || value[len(value)-1] != '>' {
		return false
	}
	parts := strings.Split(value[1:len(value)-1], "@")
	if len(parts) != 2 || len(parts[0]) == 0 || len(parts[0]) > 96 || len(parts[1]) == 0 || len(parts[1]) > 253 ||
		strings.HasPrefix(parts[0], ".") || strings.HasSuffix(parts[0], ".") || strings.Contains(parts[0], "..") {
		return false
	}
	letterOrDigit := func(b byte) bool {
		return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9'
	}
	for _, b := range []byte(parts[0]) {
		if !letterOrDigit(b) && b != '.' && b != '_' && b != '-' {
			return false
		}
	}
	for _, label := range strings.Split(parts[1], ".") {
		if len(label) == 0 || len(label) > 63 || !letterOrDigit(label[0]) || !letterOrDigit(label[len(label)-1]) {
			return false
		}
		for _, b := range []byte(label) {
			if !letterOrDigit(b) && b != '-' {
				return false
			}
		}
	}
	return true
}

// A test mailer must be explicitly injected. The production implementation
// below always requires TLS with certificate and server-name verification.
type AccountMailer interface {
	Send(context.Context, AccountMail) error
}

type SMTPConfig struct {
	Host     string
	Port     int
	TLSMode  string // "tls" (implicit TLS) or "starttls" (mandatory upgrade).
	Username string
	Password string
	From     string
}

type SMTPMailer struct {
	cfg       SMTPConfig
	tlsConfig *tls.Config
}

func plainMailAddress(value string) bool {
	if len(value) > 254 || strings.ContainsAny(value, "\r\n\x00") {
		return false
	}
	a, err := mail.ParseAddress(value)
	return err == nil && a.Address == value
}

func NewSMTPMailer(cfg SMTPConfig) (*SMTPMailer, error) {
	if cfg.Host == "" || strings.ContainsAny(cfg.Host, " /\\\t\r\n\x00") || cfg.Port < 1 || cfg.Port > 65535 {
		return nil, errors.New("SMTP requires a host and valid port")
	}
	if cfg.TLSMode != "tls" && cfg.TLSMode != "starttls" {
		return nil, errors.New("SMTP requires tls or starttls mode")
	}
	if !plainMailAddress(cfg.From) {
		return nil, errors.New("SMTP requires a valid sender address")
	}
	if (cfg.Username == "") != (cfg.Password == "") {
		return nil, errors.New("SMTP credentials must be configured together")
	}
	return &SMTPMailer{cfg: cfg, tlsConfig: &tls.Config{MinVersion: tls.VersionTLS12, ServerName: cfg.Host}}, nil
}

// Send returns success only after the SMTP server accepts DATA. It does not
// assert mailbox delivery. Transport errors must never be logged verbatim:
// SMTP servers can echo recipients or message content in their diagnostics.
func (m *SMTPMailer) Send(ctx context.Context, message AccountMail) error {
	if !plainMailAddress(message.To) || message.Subject == "" || len(message.Subject) > 200 || strings.ContainsAny(message.Subject, "\r\n\x00") || len(message.Text) > 32768 || !validAccountMailMessageID(message.MessageID) {
		return errors.New("invalid account mail")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	address := net.JoinHostPort(m.cfg.Host, strconv.Itoa(m.cfg.Port))
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	var conn net.Conn
	var err error
	if m.cfg.TLSMode == "tls" {
		conn, err = (&tls.Dialer{NetDialer: dialer, Config: m.tlsConfig.Clone()}).DialContext(ctx, "tcp", address)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", address)
	}
	if err != nil {
		return errors.New("SMTP connection failed")
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	if err = conn.SetDeadline(deadline); err != nil {
		return errors.New("SMTP deadline unavailable")
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	client, err := smtp.NewClient(conn, m.cfg.Host)
	if err != nil {
		return errors.New("SMTP greeting failed")
	}
	defer client.Close()
	if m.cfg.TLSMode == "starttls" {
		if ok, _ := client.Extension("STARTTLS"); !ok {
			return errors.New("SMTP TLS upgrade unavailable")
		}
		if err = client.StartTLS(m.tlsConfig.Clone()); err != nil {
			return errors.New("SMTP TLS verification failed")
		}
	}
	if state, ok := client.TLSConnectionState(); !ok || !state.HandshakeComplete || state.Version < tls.VersionTLS12 {
		return errors.New("SMTP TLS required")
	}
	if m.cfg.Username != "" {
		if err = client.Auth(smtp.PlainAuth("", m.cfg.Username, m.cfg.Password, m.cfg.Host)); err != nil {
			return errors.New("SMTP authentication failed")
		}
	}
	if err = client.Mail(m.cfg.From); err != nil {
		return errors.New("SMTP sender rejected")
	}
	if err = client.Rcpt(message.To); err != nil {
		return errors.New("SMTP recipient rejected")
	}
	writer, err := client.Data()
	if err != nil {
		return errors.New("SMTP message rejected")
	}
	encoded := base64.StdEncoding.EncodeToString([]byte(message.Text))
	var body strings.Builder
	for len(encoded) > 76 {
		body.WriteString(encoded[:76] + "\r\n")
		encoded = encoded[76:]
	}
	body.WriteString(encoded + "\r\n")
	header := fmt.Sprintf("From: Tropnik <%s>\r\nTo: <%s>\r\nSubject: %s\r\nMessage-ID: %s\r\nDate: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n", m.cfg.From, message.To, mime.BEncoding.Encode("UTF-8", message.Subject), message.MessageID, time.Now().UTC().Format(time.RFC1123Z))
	if _, err = writer.Write([]byte(header + body.String())); err != nil {
		return errors.New("SMTP write failed")
	}
	if err = writer.Close(); err != nil {
		return errors.New("SMTP acceptance failed")
	}
	// DATA acceptance is the success boundary; a failed QUIT must not trigger a
	// duplicate email. Close still releases the connection on every path.
	_ = client.Quit()
	return nil
}
