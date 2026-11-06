package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata"

	"tropa/backend/internal/auth"
	"tropa/backend/internal/httpapi"
	"tropa/backend/internal/store"
)

func main() {
	if e := run(); e != nil {
		slog.Error("API could not start", "reason", e.Error())
		os.Exit(1)
	}
}
func run() error {
	mode := os.Getenv("APP_ENV")
	if mode == "" {
		mode = "production"
	}
	if mode != "production" && mode != "development" {
		return errors.New("APP_ENV must be production or development")
	}
	if os.Getenv("DEMO_MODE") != "" && os.Getenv("DEMO_MODE") != "false" {
		return errors.New("demo fixtures are not supported by this server")
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return errors.New("DATABASE_URL is required")
	}
	origin := os.Getenv("PUBLIC_ORIGIN")
	if origin == "" {
		if mode == "production" {
			return errors.New("PUBLIC_ORIGIN with HTTPS is required in production")
		}
		origin = "http://localhost:3000"
	}
	u, e := url.Parse(origin)
	if e != nil || u.Host == "" || u.Path != "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("PUBLIC_ORIGIN must be an origin without path or credentials")
	}
	if mode == "production" {
		if u.Scheme != "https" {
			return errors.New("production requires HTTPS termination")
		}
		db, e := url.Parse(dsn)
		if e != nil || db.User == nil {
			return errors.New("production DATABASE_URL must be a PostgreSQL URL with credentials")
		}
		password, _ := db.User.Password()
		if len(password) < 24 || strings.Contains(strings.ToLower(password), "changeme") || password == "postgres" {
			return errors.New("production database credential must be unique and at least 24 characters")
		}
		if db.Query().Get("sslmode") != "verify-full" && os.Getenv("TRUST_PRIVATE_DATABASE_NETWORK") != "true" {
			return errors.New("production database must use sslmode=verify-full; a private isolated network requires an explicit trust setting")
		}
	}
	trusted := []netip.Prefix{}
	for _, v := range strings.Split(os.Getenv("TRUSTED_PROXY_CIDRS"), ",") {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		p, e := netip.ParsePrefix(v)
		if e != nil {
			return errors.New("invalid TRUSTED_PROXY_CIDRS")
		}
		if p.Bits() == 0 {
			return errors.New("an internet-wide proxy trust range is not allowed")
		}
		trusted = append(trusted, p)
	}
	rateKey, e := auth.ParseServerKey(os.Getenv("TROPA_AUTH_RATE_KEY"))
	if e != nil {
		return errors.New("TROPA_AUTH_RATE_KEY is required and must contain 64 hexadecimal characters")
	}
	var proxyToken []byte
	if value := os.Getenv("TROPA_PROXY_TOKEN"); value != "" {
		proxyToken, e = auth.ParseServerKey(value)
		if e != nil {
			return errors.New("TROPA_PROXY_TOKEN must contain 64 hexadecimal characters")
		}
	}
	cfg := httpapi.Config{Origins: []string{origin}, HTTPS: u.Scheme == "https", TrustedProxyCIDRs: trusted, ProxyToken: proxyToken, AuthRateKey: rateKey}
	cfg.AccountLifecycle, e = accountLifecycleConfig(os.Getenv)
	if e != nil {
		return e
	}
	if e := cfg.Validate(); e != nil {
		return e
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db, e := store.New(ctx, dsn)
	if e != nil {
		return errors.New("database connection failed; inspect server configuration without logging credentials")
	}
	defer db.Close()
	if e = db.Ready(ctx); e != nil {
		return errors.New("database migrations are missing; run tropa-migrate first")
	}
	if mode == "production" {
		var privileged bool
		e = db.Pool.QueryRow(ctx, "SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls FROM pg_roles WHERE rolname=current_user").Scan(&privileged)
		if e != nil || privileged {
			return errors.New("API must use an unprivileged database role; keep the operator credential separate")
		}
	}
	app, e := httpapi.New(db, cfg)
	if e != nil {
		return errors.New("authentication initialization failed")
	}
	defer func() {
		shutdownCtx, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = app.Shutdown(shutdownCtx)
	}()
	addr := os.Getenv("HTTP_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	srv := &http.Server{Addr: addr, Handler: app.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(stop)
	serveFinished := make(chan struct{})
	shutdownFinished := make(chan struct{})
	go func() {
		defer close(shutdownFinished)
		select {
		case <-stop:
		case <-serveFinished:
			return
		}
		c, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		if err := srv.Shutdown(c); err != nil {
			_ = srv.Close()
		}
	}()
	slog.Info("TROPA API ready", "address", addr, "mode", mode)
	e = srv.ListenAndServe()
	close(serveFinished)
	<-shutdownFinished
	if errors.Is(e, http.ErrServerClosed) {
		return nil
	}
	return e
}
