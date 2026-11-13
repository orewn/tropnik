package auth

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/textproto"
	"strconv"
	"strings"
	"testing"
	"time"
)

type smtpObservation struct {
	body               string
	cleartextSensitive bool
}

// This harness only listens on loopback and receives example.invalid mail. No
// external connection or real delivery is made by these tests.
func localSMTP(t *testing.T, mode string, offerTLS bool, loseAcceptance ...bool) (SMTPConfig, *x509.CertPool, <-chan smtpObservation) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, DNSNames: []string{"localhost"}, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	encodedKey, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := tls.X509KeyPair(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: encodedKey}))
	if err != nil {
		t.Fatal(err)
	}
	root, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(root)
	tlsConfig := &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	observed := make(chan smtpObservation, 1)
	go func() {
		result := smtpObservation{}
		defer func() { observed <- result }()
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		secure := mode == "tls"
		if secure {
			conn = tls.Server(conn, tlsConfig)
		}
		reader := textproto.NewReader(bufio.NewReader(conn))
		if _, err = fmt.Fprint(conn, "220 localhost test SMTP\r\n"); err != nil {
			return
		}
		for {
			line, err := reader.ReadLine()
			if err != nil {
				return
			}
			switch {
			case strings.HasPrefix(line, "EHLO "):
				if !secure && offerTLS {
					_, _ = fmt.Fprint(conn, "250-localhost\r\n250 STARTTLS\r\n")
				} else {
					_, _ = fmt.Fprint(conn, "250-localhost\r\n250 AUTH PLAIN\r\n")
				}
			case line == "STARTTLS":
				_, _ = fmt.Fprint(conn, "220 Ready\r\n")
				tlsConn := tls.Server(conn, tlsConfig)
				if err = tlsConn.Handshake(); err != nil {
					return
				}
				conn = tlsConn
				reader = textproto.NewReader(bufio.NewReader(conn))
				secure = true
			case strings.HasPrefix(line, "AUTH "), strings.HasPrefix(line, "MAIL FROM:"), strings.HasPrefix(line, "RCPT TO:"):
				if !secure {
					result.cleartextSensitive = true
				}
				if strings.HasPrefix(line, "AUTH ") {
					_, _ = fmt.Fprint(conn, "235 authenticated\r\n")
				} else {
					_, _ = fmt.Fprint(conn, "250 accepted\r\n")
				}
			case line == "DATA":
				if !secure {
					result.cleartextSensitive = true
				}
				_, _ = fmt.Fprint(conn, "354 send message\r\n")
				body, err := reader.ReadDotBytes()
				if err != nil {
					return
				}
				result.body = string(body)
				if len(loseAcceptance) > 0 && loseAcceptance[0] {
					// Model a queued DATA body whose final acceptance reply is
					// lost. The sender cannot know whether delivery happened.
					return
				}
				_, _ = fmt.Fprint(conn, "250 queued\r\n")
			case line == "QUIT":
				_, _ = fmt.Fprint(conn, "221 bye\r\n")
				return
			default:
				_, _ = fmt.Fprint(conn, "500 unsupported\r\n")
			}
		}
	}()
	host, portText, _ := net.SplitHostPort(listener.Addr().String())
	port, _ := strconv.Atoi(portText)
	return SMTPConfig{Host: host, Port: port, TLSMode: mode, Username: "test-user", Password: "test-password", From: "accounts@example.invalid"}, roots, observed
}

func TestAccountSMTPRequiresVerifiedTLSBeforeCredentialsAndContent(t *testing.T) {
	for _, mode := range []string{"tls", "starttls"} {
		t.Run(mode, func(t *testing.T) {
			cfg, roots, observed := localSMTP(t, mode, true)
			mailer, err := NewSMTPMailer(cfg)
			if err != nil {
				t.Fatal(err)
			}
			mailer.tlsConfig.RootCAs = roots // trusts this isolated fixture only
			message := AccountMail{To: "person@example.invalid", Subject: "Подтверждение почты", Text: "Fixture link https://tropnik.example/account/action#token=fixture", MessageID: "<tropnik-account-00000000-0000-4000-8000-000000000001@tropnik.example>"}
			if err = mailer.Send(context.Background(), message); err != nil {
				t.Fatal(err)
			}
			result := <-observed
			if result.cleartextSensitive || !strings.Contains(result.body, "To: <person@example.invalid>") {
				t.Fatal("unsafe or missing envelope")
			}
			parts := strings.SplitN(result.body, "\n\n", 2)
			if len(parts) != 2 {
				t.Fatal("missing MIME body")
			}
			raw, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(strings.TrimSpace(parts[1]), "\n", ""))
			if err != nil || string(raw) != message.Text {
				t.Fatal("message body did not round-trip", err)
			}
		})
	}
}

func TestAccountSMTPRejectsUntrustedCertificateAndNoSTARTTLS(t *testing.T) {
	for _, tc := range []struct {
		mode  string
		offer bool
	}{{"tls", true}, {"starttls", false}, {"starttls", true}} {
		t.Run(fmt.Sprintf("%s/%v", tc.mode, tc.offer), func(t *testing.T) {
			cfg, _, observed := localSMTP(t, tc.mode, tc.offer)
			mailer, err := NewSMTPMailer(cfg)
			if err != nil {
				t.Fatal(err)
			}
			if err = mailer.Send(context.Background(), AccountMail{To: "person@example.invalid", Subject: "Fixture", Text: "secret", MessageID: "<tropnik-account-00000000-0000-4000-8000-000000000001@tropnik.example>"}); err == nil {
				t.Fatal("unverified transport accepted")
			}
			result := <-observed
			if result.body != "" || result.cleartextSensitive {
				t.Fatal("content exposed before verified TLS")
			}
		})
	}
}

func TestAccountMailMessageIDUsesOnlyValidatedStableConfiguration(t *testing.T) {
	const expected = "<tropnik-account-00000000-0000-4000-8000-000000000001@tropnik.example>"
	for _, endpoint := range []string{"https://tropnik.example/account/action", "https://TROPNIK.example:443/tropnik/account/action/"} {
		for attempt := 0; attempt < 2; attempt++ {
			id, err := AccountMailMessageID(accountMailFixtureJob, endpoint)
			if err != nil || id != expected {
				t.Fatal("message identifier was not stable", err)
			}
		}
	}
	for _, endpoint := range []string{"http://tropnik.example/action", "https://user@tropnik.example/action", "https://tropnik.example/action?q=1", "https://tropnik.example/action#secret", "https://tropnik.example\r\nBcc:other.invalid", "https://[::1]/action", "https://пример.рф/action", "https://bad_host.invalid/action", "https://bad..invalid/action"} {
		if id, err := AccountMailMessageID(accountMailFixtureJob, endpoint); err == nil || id != "" {
			t.Fatal("invalid action hostname or endpoint accepted")
		}
	}
	if id, err := AccountMailMessageID("job\r\nBcc: injected", "https://tropnik.example/action"); err == nil || id != "" {
		t.Fatal("invalid job identifier accepted")
	}
}

func TestAccountSMTPRequiresAStableSafeMessageIdentifierBeforeConnecting(t *testing.T) {
	mailer, err := NewSMTPMailer(SMTPConfig{Host: "127.0.0.1", Port: 1, TLSMode: "tls", From: "accounts@example.invalid"})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"", "id@example.invalid", "<one@example.invalid>\r\nBcc: victim@example.invalid", "<one\x00@example.invalid>", "<one@@example.invalid>", "<one..two@example.invalid>", "<one@bad..invalid>", "<one@-bad.invalid>", "<one@bad_.invalid>", "<one@пример.рф>"} {
		err := mailer.Send(context.Background(), AccountMail{To: "person@example.invalid", Subject: "Fixture", Text: "private fixture", MessageID: id})
		if err == nil || err.Error() != "invalid account mail" {
			t.Fatal("invalid header reached the network or diagnostics", err)
		}
	}
}

func TestAccountSMTPRetriesReuseTheMessageIDAndOriginalBody(t *testing.T) {
	id, err := AccountMailMessageID(accountMailFixtureJob, "https://tropnik.example/account/action")
	if err != nil {
		t.Fatal(err)
	}
	message := AccountMail{To: "person@example.invalid", Subject: "Повтор доставки", Text: "Same private fixture link #token=FIXED-TOKEN", MessageID: id}
	for attempt := 0; attempt < 2; attempt++ {
		cfg, roots, observed := localSMTP(t, "tls", true, attempt == 0)
		mailer, err := NewSMTPMailer(cfg)
		if err != nil {
			t.Fatal(err)
		}
		mailer.tlsConfig.RootCAs = roots
		err = mailer.Send(context.Background(), message)
		if (attempt == 0 && err == nil) || (attempt == 1 && err != nil) {
			t.Fatal("unexpected SMTP acceptance result", err)
		}
		result := <-observed
		if strings.Count(result.body, "Message-ID: "+id+"\n") != 1 || result.cleartextSensitive {
			t.Fatal("retry changed or duplicated its identifier")
		}
		parts := strings.SplitN(result.body, "\n\n", 2)
		if len(parts) != 2 {
			t.Fatal("missing retry body")
		}
		body, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(strings.TrimSpace(parts[1]), "\n", ""))
		if err != nil || string(body) != message.Text {
			t.Fatal("retry changed the token or message body", err)
		}
	}
}
