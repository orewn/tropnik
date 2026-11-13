package httpapi

import (
    "bytes"
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
    mu sync.Mutex
    registered int
    queued []string
    queueError error
}
func (f *lifecycleFixture) ConfigureAccountMail(context.Context,[]byte) error { return nil }
func (f *lifecycleFixture) RegisterWithAccountMail(_ context.Context,email,hash,name,role string) (domain.User,error) {
    f.mu.Lock();defer f.mu.Unlock()
    if f.queueError!=nil { return domain.User{},f.queueError }
    f.registered++
    return domain.User{ID:"test-account",Email:email,DisplayName:name,Role:role,StaffRole:"none"},nil
}
func (f *lifecycleFixture) QueueAccountMail(_ context.Context,email,purpose string) error {
    f.mu.Lock();defer f.mu.Unlock()
    if f.queueError!=nil { return f.queueError }
    f.queued=append(f.queued,email)
    return nil
}
func (f *lifecycleFixture) ClaimAccountMail(context.Context) (store.AccountMailLease,error) { return store.AccountMailLease{},domain.ErrNotFound }
func (f *lifecycleFixture) PrepareAccountMail(context.Context,store.AccountMailLease,string) (auth.AccountMail,error) { return auth.AccountMail{},domain.ErrNotFound }
func (f *lifecycleFixture) FinishAccountMail(context.Context,store.AccountMailLease,bool) error { return nil }
func (f *lifecycleFixture) PruneAccountMail(context.Context) error { return nil }
func (f *lifecycleFixture) Credentials(context.Context,string) (string,string,error) { return "","",domain.ErrNotFound }
func (f *lifecycleFixture) VerifyAccountEmail(context.Context,[32]byte) error { return store.ErrAccountAction }
func (f *lifecycleFixture) ResetAccountPasswordWithMail(context.Context,[32]byte,string) (store.AccountActionRecipient,error) { return store.AccountActionRecipient{},store.ErrAccountAction }
func (f *lifecycleFixture) DeleteAccount(context.Context,string,string) error { return domain.ErrUnauthorized }

type lifecycleMailer func(context.Context,auth.AccountMail) error
func (m lifecycleMailer) Send(ctx context.Context,mail auth.AccountMail) error { return m(ctx,mail) }

func lifecycleServer(t *testing.T) (*Server,*lifecycleFixture) {
    t.Helper()
    s:=testServer(t,Config{})
    fixture:=&lifecycleFixture{}
    cfg:=&AccountLifecycleConfig{Mailer:lifecycleMailer(func(context.Context,auth.AccountMail) error { t.Error("unit fixture must not send mail");return errors.New("no transport") }),ActionURL:"https://tropnik.example/account/action",MailKey:bytes.Repeat([]byte{11},32)}
    var err error
    s.lifecycle,err=newAccountLifecycle(fixture,cfg)
    if err!=nil { t.Fatal(err) }
    t.Cleanup(func(){ctx,cancel:=context.WithTimeout(context.Background(),time.Second);defer cancel();if err:=s.Shutdown(ctx);err!=nil { t.Error(err) }})
    return s,fixture
}

func lifecycleRequest(s *Server,path,body string) *httptest.ResponseRecorder {
    r:=httptest.NewRequest("POST","/api/v1/"+path,strings.NewReader(body))
    r.Header.Set("Content-Type","application/json")
    w:=httptest.NewRecorder();s.Handler().ServeHTTP(w,r);return w
}

func TestRegistrationIsClosedWithoutAnExplicitMailTransport(t *testing.T) {
    s:=testServer(t,Config{})
    w:=lifecycleRequest(s,"auth/register",`{"email":"person@example.invalid","password":"strong fixture password","displayName":"Test person","role":"tourist"}`)
    if w.Code!=503 || !strings.Contains(w.Body.String(),"registration_unavailable") || strings.Contains(w.Body.String(),"token") { t.Fatal(w.Code,w.Body.String()) }
}

func TestRegistrationDelegatesToTheAtomicDurableStore(t *testing.T) {
    s,f:=lifecycleServer(t)
    u,err:=s.registerWithMail(context.Background(),"person@example.invalid","test-hash","Test person","tourist")
    if err!=nil || u.ID=="" || u.EmailVerified || f.registered!=1 { t.Fatal("atomic registration was not called",err) }
    f.queueError=store.ErrAccountMailQueueFull
    if _,err=s.registerWithMail(context.Background(),"second@example.invalid","test-hash","Test","tourist");!errors.Is(err,store.ErrAccountMailQueueFull) { t.Fatal("queue failure discarded",err) }
}

func TestRecoveryResponsesAreUniformAndQueueAllAddressesWithoutLookup(t *testing.T) {
    s,f:=lifecycleServer(t)
    a:=lifecycleRequest(s,"auth/password/request",`{"email":"person@example.invalid"}`)
    b:=lifecycleRequest(s,"auth/password/request",`{"email":"absent@example.invalid"}`)
    if a.Code!=202 || b.Code!=202 || a.Body.String()!=b.Body.String() { t.Fatal("account enumeration through response",a.Code,b.Code) }
    if strings.Contains(a.Body.String(),"token") || len(f.queued)!=2 { t.Fatal("durable intent missing or secret exposed") }
}

func TestPerAddressMailLimitKeepsTheUniformResponseAndDoesNotQueue(t *testing.T) {
    s,f:=lifecycleServer(t)
    s.authBudget=budgetFunc(func(_ context.Context,scope string,_ [32]byte)(store.AuthAttempt,error){ return store.AuthAttempt{Allowed:scope!=store.AccountMailScope,RetryAfter:900},nil })
    w:=lifecycleRequest(s,"auth/password/request",`{"email":"person@example.invalid"}`)
    if w.Code!=202 || len(f.queued)!=0 { t.Fatal("rate limit bypassed",w.Code) }
}

func TestDurableQueueFailureIsNotReportedAsAccepted(t *testing.T) {
    s,f:=lifecycleServer(t)
    f.queueError=store.ErrAccountMailQueueFull
    w:=lifecycleRequest(s,"auth/email/request",`{"email":"person@example.invalid"}`)
    if w.Code!=503 || len(f.queued)!=0 || strings.Contains(w.Body.String(),"person@example.invalid") { t.Fatal(w.Code,w.Body.String()) }
    ctx,cancel:=context.WithTimeout(context.Background(),time.Second);defer cancel()
    if err:=s.Shutdown(ctx);err!=nil { t.Fatal(err) }
    f.queueError=nil
    if _,err:=s.registerWithMail(context.Background(),"person@example.invalid","hash","Test","tourist");err==nil { t.Fatal("registration accepted after shutdown") }
}

func TestAccountActionMalformedAndSpentLinksShareSafeFailure(t *testing.T) {
    s,_:=lifecycleServer(t)
    for _,raw:=range []string{"short",strings.Repeat("A",43)} {
        w:=lifecycleRequest(s,"auth/email/confirm",`{"token":"`+raw+`"}`)
        if w.Code!=400 || !strings.Contains(w.Body.String(),"account_link_invalid") || strings.Contains(w.Body.String(),raw) { t.Fatal(w.Code,w.Body.String()) }
    }
}
