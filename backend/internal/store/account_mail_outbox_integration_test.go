//go:build integration

package store_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"tropa/backend/internal/auth"
	"tropa/backend/internal/domain"
	"tropa/backend/internal/store"
	"tropa/backend/migrations"
)

var fixtureMailKey = bytes.Repeat([]byte{11},32)
const fixtureActionURL = "https://tropnik.example/account/action"

func mailDB(t *testing.T) *store.Store {
	t.Helper()
	s:=db(t)
	if err:=s.ConfigureAccountMail(context.Background(),fixtureMailKey);err!=nil { t.Fatal(err) }
	return s
}

func independentMailStore(t *testing.T,s *store.Store,key []byte) (*store.Store,error) {
	t.Helper()
	pool,err:=pgxpool.NewWithConfig(context.Background(),s.Pool.Config())
	if err!=nil { t.Fatal(err) }
	other:=&store.Store{Pool:pool}
	t.Cleanup(other.Close)
	return other,other.ConfigureAccountMail(context.Background(),key)
}

func prepareMail(t *testing.T,s *store.Store) (store.AccountMailLease,auth.AccountMail) {
	t.Helper()
	lease,err:=s.ClaimAccountMail(context.Background())
	if err!=nil { t.Fatal("claim",err) }
	message,err:=s.PrepareAccountMail(context.Background(),lease,fixtureActionURL)
	if err!=nil { t.Fatal("prepare",err) }
	return lease,message
}

func mailActionDigest(t *testing.T,message auth.AccountMail) [32]byte {
	t.Helper()
	for _,field:=range strings.Fields(message.Text) {
		if !strings.HasPrefix(field,"https://") { continue }
		u,err:=url.Parse(field)
		if err!=nil { t.Fatal("invalid action link") }
		fragment,err:=url.ParseQuery(u.Fragment)
		if err!=nil { t.Fatal("invalid fragment") }
		digest,err:=auth.AccountActionDigest(fragment.Get("token"))
		if err!=nil { t.Fatal("invalid action token") }
		return digest
	}
	t.Fatal("mail action not present")
	return [32]byte{}
}

func assertMailScrubbed(t *testing.T,s *store.Store,id,state string) {
	t.Helper()
	var valid bool
	err:=s.Pool.QueryRow(context.Background(),`SELECT state=$2 AND payload_cipher IS NULL AND payload_nonce IS NULL
AND recipient_key IS NULL AND lease_id IS NULL AND lease_until IS NULL AND finished_at IS NOT NULL
FROM account_mail_outbox WHERE id=$1`,id,state).Scan(&valid)
	if err!=nil || !valid { t.Fatal("terminal mail retained payload or incorrect state",err) }
}

func TestAccountMailRegistrationAndResetAreAtomicAtQueueCapacity(t *testing.T) {
	s:=mailDB(t)
	ctx:=context.Background()
	u:=account(t,s,"mail-capacity-reset","tourist")
	_,digest:=actionToken(t,s,u.Email,store.ResetPasswordAction)
	_,oldHash,err:=s.Credentials(ctx,u.Email)
	if err!=nil { t.Fatal(err) }
	session,_:=auth.SessionToken()
	if err=s.CreateSession(ctx,u.ID,session,time.Now().Add(time.Hour));err!=nil { t.Fatal(err) }
	for i:=0;i<store.AccountMailQueueLimit;i++ {
		if err=s.QueueAccountMail(ctx,fmt.Sprintf("queue-%02d@example.invalid",i),store.VerifyEmailAction);err!=nil { t.Fatal(err) }
	}
	if err=s.QueueAccountMail(ctx,"overflow@example.invalid",store.VerifyEmailAction);!errors.Is(err,store.ErrAccountMailQueueFull) { t.Fatal("queue bound missing",err) }
	if _,err=s.RegisterWithAccountMail(ctx,"rollback@example.invalid","hash","Rollback","tourist");!errors.Is(err,store.ErrAccountMailQueueFull) { t.Fatal("registration committed without durable mail",err) }
	var created int
	if err=s.Pool.QueryRow(ctx,"SELECT count(*) FROM users WHERE email='rollback@example.invalid'").Scan(&created);err!=nil || created!=0 { t.Fatal("orphaned registration",err) }
	if _,err=s.ResetAccountPasswordWithMail(ctx,digest,strings.Repeat("replacement-fixture",3));!errors.Is(err,store.ErrAccountMailQueueFull) { t.Fatal("reset committed without notification",err) }
	_,current,err:=s.Credentials(ctx,u.Email)
	if err!=nil || current!=oldHash { t.Fatal("failed queue changed credentials",err) }
	if _,err=s.SessionUser(ctx,session);err!=nil { t.Fatal("failed reset revoked the session",err) }
	var untouched bool
	if err=s.Pool.QueryRow(ctx,"SELECT consumed_at IS NULL AND revoked_at IS NULL FROM account_action_tokens WHERE token_hash=$1",digest[:]).Scan(&untouched);err!=nil || !untouched { t.Fatal("failed reset consumed its token",err) }
	// Coalescing an existing anonymous request remains possible at the bound.
	if err=s.QueueAccountMail(ctx,"queue-00@example.invalid",store.VerifyEmailAction);err!=nil { t.Fatal("pending request not coalesced",err) }
}

func TestAccountMailAtomicRegistrationReplacesAnAnonymousIntent(t *testing.T) {
	s:=mailDB(t)
	ctx:=context.Background()
	email:="new-account@example.invalid"
	if err:=s.QueueAccountMail(ctx,email,store.VerifyEmailAction);err!=nil { t.Fatal(err) }
	var oldID string
	if err:=s.Pool.QueryRow(ctx,"SELECT id::text FROM account_mail_outbox").Scan(&oldID);err!=nil { t.Fatal(err) }
	u,err:=s.RegisterWithAccountMail(ctx,email,"hash","Registration fixture","tourist")
	if err!=nil { t.Fatal(err) }
	assertMailScrubbed(t,s,oldID,"cancelled")
	lease,message:=prepareMail(t,s)
	if message.To!=u.Email || message.MessageID=="" { t.Fatal("incorrect durable registration recipient") }
	if err=s.FinishAccountMail(ctx,lease,true);err!=nil { t.Fatal(err) }
	assertMailScrubbed(t,s,lease.ID,"accepted")
	if err=s.VerifyAccountEmail(ctx,mailActionDigest(t,message));err!=nil { t.Fatal("accepted verification is invalid",err) }
}

// The parent runs this helper as an actual second process. It exits abruptly
// after persisting the prepared message and before any acknowledgement. The
// test credentials and receiver are synthetic and the helper never uses SMTP.
func TestAccountMailCrashHelper(t *testing.T) {
	dsn:=os.Getenv("TROPA_MAIL_TEST_CRASH_DSN")
	if dsn=="" { return }
	u,err:=url.Parse(dsn)
	if err!=nil || !strings.HasSuffix(strings.TrimPrefix(u.Path,"/"),"_test") { t.Fatal("unsafe crash fixture database") }
	ctx:=context.Background()
	s,err:=store.New(ctx,dsn)
	if err!=nil { t.Fatal("crash fixture open failed") }
	if err=s.ConfigureAccountMail(ctx,nil);err!=nil { t.Fatal("crash fixture key failed") }
	lease,err:=s.ClaimAccountMail(ctx)
	if err!=nil { t.Fatal("crash fixture claim failed") }
	if _,err=s.PrepareAccountMail(ctx,lease,fixtureActionURL);err!=nil { t.Fatal("crash fixture prepare failed") }
	os.Exit(73)
}

func TestAccountMailProcessRestartPreservesPayloadAndFencesOldLease(t *testing.T) {
	s:=mailDB(t)
	ctx:=context.Background()
	u:=account(t,s,"mail-restart","tourist")
	if err:=s.QueueAccountMail(ctx,u.Email,store.ResetPasswordAction);err!=nil { t.Fatal(err) }
	command:=exec.Command(os.Args[0],"-test.run=^TestAccountMailCrashHelper$")
	command.Env=append(os.Environ(),"TROPA_MAIL_TEST_CRASH_DSN="+s.Pool.Config().ConnString(),"TROPA_ACCOUNT_MAIL_KEY="+hex.EncodeToString(fixtureMailKey))
	err:=command.Run()
	var exited *exec.ExitError
	if !errors.As(err,&exited) || exited.ExitCode()!=73 { t.Fatal("worker did not exit at the prepared-message crash point") }
	var first store.AccountMailLease
	if err=s.Pool.QueryRow(ctx,"SELECT id::text,lease_id::text FROM account_mail_outbox WHERE state='leased'").Scan(&first.ID,&first.LeaseID);err!=nil { t.Fatal(err) }
	var before []byte
	if err=s.Pool.QueryRow(ctx,"SELECT payload_cipher FROM account_mail_outbox WHERE id=$1",first.ID).Scan(&before);err!=nil { t.Fatal(err) }
	if _,err=independentMailStore(t,s,nil);!errors.Is(err,store.ErrAccountMailUnavailable) { t.Fatal("missing key accepted a backlog",err) }
	if _,err=independentMailStore(t,s,bytes.Repeat([]byte{12},32));!errors.Is(err,store.ErrAccountMailUnavailable) { t.Fatal("replaced key accepted a backlog",err) }
	restarted,err:=independentMailStore(t,s,fixtureMailKey)
	if err!=nil { t.Fatal(err) }
	if _,err=restarted.ClaimAccountMail(ctx);!errors.Is(err,domain.ErrNotFound) { t.Fatal("live lease was stolen",err) }
	// Advance the fixture's lease clock without waiting a minute in CI.
	if _,err=s.Pool.Exec(ctx,"UPDATE account_mail_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",first.ID);err!=nil { t.Fatal(err) }
	second,message:=prepareMail(t,restarted)
	if second.ID!=first.ID || second.LeaseID==first.LeaseID { t.Fatal("restart did not replace the lease fence") }
	var after []byte
	if err=s.Pool.QueryRow(ctx,"SELECT payload_cipher FROM account_mail_outbox WHERE id=$1",first.ID).Scan(&after);err!=nil || !bytes.Equal(before,after) { t.Fatal("restart replaced the original sealed payload",err) }
	if err=s.FinishAccountMail(ctx,first,true);err!=nil { t.Fatal(err) }
	var stillLeased bool
	if err=s.Pool.QueryRow(ctx,"SELECT state='leased' AND lease_id=$2 FROM account_mail_outbox WHERE id=$1",second.ID,second.LeaseID).Scan(&stillLeased);err!=nil || !stillLeased { t.Fatal("stale acknowledgement changed current work",err) }
	if err=restarted.FinishAccountMail(ctx,second,true);err!=nil { t.Fatal(err) }
	assertMailScrubbed(t,s,second.ID,"accepted")
	if _,err=s.ResetAccountPasswordWithMail(ctx,mailActionDigest(t,message),strings.Repeat("restarted-password",3));err!=nil { t.Fatal("recovered token unusable",err) }
}

func TestAccountMailAmbiguousAcceptanceRetriesTheSameUsableToken(t *testing.T) {
	s:=mailDB(t)
	ctx:=context.Background()
	u:=account(t,s,"mail-ambiguous","tourist")
	if err:=s.QueueAccountMail(ctx,u.Email,store.ResetPasswordAction);err!=nil { t.Fatal(err) }
	first,original:=prepareMail(t,s)
	digest:=mailActionDigest(t,original)
	// The SMTP transport separately tests DATA accepted followed by a lost 250.
	// It returns failure in this case; persistence must retain the original link.
	if err:=s.FinishAccountMail(ctx,first,false);err!=nil { t.Fatal(err) }
	var pending bool
	if err:=s.Pool.QueryRow(ctx,`SELECT state='pending' AND payload_cipher IS NOT NULL AND next_attempt_at>clock_timestamp()
FROM account_mail_outbox WHERE id=$1`,first.ID).Scan(&pending);err!=nil || !pending { t.Fatal("ambiguous send was dropped or not backed off",err) }
	if _,err:=s.Pool.Exec(ctx,"UPDATE account_mail_outbox SET next_attempt_at=clock_timestamp() WHERE id=$1",first.ID);err!=nil { t.Fatal(err) }
	restarted,err:=independentMailStore(t,s,fixtureMailKey)
	if err!=nil { t.Fatal(err) }
	second,retry:=prepareMail(t,restarted)
	if original!=retry || original.MessageID=="" || mailActionDigest(t,retry)!=digest { t.Fatal("retry changed message, token or Message-ID") }
	if err=s.FinishAccountMail(ctx,first,false);err!=nil { t.Fatal(err) }
	var live bool
	if err=s.Pool.QueryRow(ctx,"SELECT revoked_at IS NULL AND consumed_at IS NULL FROM account_action_tokens WHERE token_hash=$1",digest[:]).Scan(&live);err!=nil || !live { t.Fatal("stale failure revoked retry token",err) }
	if err=restarted.FinishAccountMail(ctx,second,true);err!=nil { t.Fatal(err) }
	assertMailScrubbed(t,s,second.ID,"accepted")
	if _,err=s.ResetAccountPasswordWithMail(ctx,digest,strings.Repeat("ambiguous-password",3));err!=nil { t.Fatal("previously delivered retry link is invalid",err) }
	var notices int
	if err=s.Pool.QueryRow(ctx,"SELECT count(*) FROM account_mail_outbox WHERE user_id=$1 AND purpose='password_changed' AND state='pending'",u.ID).Scan(&notices);err!=nil || notices!=1 { t.Fatal("reset notification is not durable",err) }
}

func TestAccountMailAttemptsAreBoundedAndTerminalPayloadIsScrubbed(t *testing.T) {
	s:=mailDB(t)
	ctx:=context.Background()
	u:=account(t,s,"mail-retry-bound","tourist")
	if err:=s.QueueAccountMail(ctx,u.Email,store.ResetPasswordAction);err!=nil { t.Fatal(err) }
	var first auth.AccountMail
	var last store.AccountMailLease
	for attempt:=1;attempt<=8;attempt++ {
		lease,message:=prepareMail(t,s)
		if attempt==1 { first=message } else if message!=first { t.Fatal("bounded retry changed token") }
		last=lease
		if err:=s.FinishAccountMail(ctx,lease,false);err!=nil { t.Fatal(err) }
		if attempt<8 {
			if _,err:=s.Pool.Exec(ctx,"UPDATE account_mail_outbox SET next_attempt_at=clock_timestamp() WHERE id=$1",lease.ID);err!=nil { t.Fatal(err) }
		}
	}
	assertMailScrubbed(t,s,last.ID,"failed")
	if _,err:=s.ClaimAccountMail(ctx);!errors.Is(err,domain.ErrNotFound) { t.Fatal("terminal mail retried",err) }
	if _,err:=s.ResetAccountPasswordWithMail(ctx,mailActionDigest(t,first),strings.Repeat("should-not-reset",3));!errors.Is(err,store.ErrAccountAction) { t.Fatal("terminal token stayed valid",err) }
	if _,err:=s.Pool.Exec(ctx,"UPDATE account_mail_outbox SET finished_at=clock_timestamp()-interval '25 hours' WHERE id=$1",last.ID);err!=nil { t.Fatal(err) }
	if err:=s.PruneAccountMail(ctx);err!=nil { t.Fatal(err) }
	var total int
	if err:=s.Pool.QueryRow(ctx,"SELECT count(*) FROM account_mail_outbox").Scan(&total);err!=nil || total!=0 { t.Fatal("terminal retention unbounded",err) }
}

func TestAccountMailRevocationAndClosureScrubPendingSecrets(t *testing.T) {
	s:=mailDB(t)
	ctx:=context.Background()
	u:=account(t,s,"mail-close","tourist")
	if err:=s.QueueAccountMail(ctx,u.Email,store.ResetPasswordAction);err!=nil { t.Fatal(err) }
	lease,message:=prepareMail(t,s)
	if err:=s.RevokeAccountAction(ctx,mailActionDigest(t,message));err!=nil { t.Fatal(err) }
	assertMailScrubbed(t,s,lease.ID,"cancelled")
	if err:=s.FinishAccountMail(ctx,lease,true);err!=nil { t.Fatal(err) }
	assertMailScrubbed(t,s,lease.ID,"cancelled")
	if err:=s.QueueAccountMail(ctx,u.Email,store.VerifyEmailAction);err!=nil { t.Fatal(err) }
	var anonymous string
	if err:=s.Pool.QueryRow(ctx,"SELECT id::text FROM account_mail_outbox WHERE user_id IS NULL AND state='pending'").Scan(&anonymous);err!=nil { t.Fatal(err) }
	_,hash,err:=s.Credentials(ctx,u.Email)
	if err!=nil { t.Fatal(err) }
	if err=s.DeleteAccount(ctx,u.ID,hash);err!=nil { t.Fatal(err) }
	assertMailScrubbed(t,s,anonymous,"cancelled")
	if _,err=s.ClaimAccountMail(ctx);!errors.Is(err,domain.ErrNotFound) { t.Fatal("closure retained sendable work",err) }
}

func TestAccountMailExpiredDamagedCiphertextReleasesCapacityAndRevokesOnlyItsToken(t *testing.T) {
	s:=mailDB(t)
	ctx:=context.Background()
	u:=account(t,s,"mail-expired-corrupt","tourist")
	if err:=s.QueueAccountMail(ctx,u.Email,store.ResetPasswordAction);err!=nil { t.Fatal(err) }
	lease,message:=prepareMail(t,s)
	digest:=mailActionDigest(t,message)
	if _,err:=s.Pool.Exec(ctx,`UPDATE account_mail_outbox SET payload_cipher=decode(repeat('44',64),'hex'),
created_at=clock_timestamp()-interval '31 minutes',expires_at=clock_timestamp()-interval '2 minutes' WHERE id=$1`,lease.ID);err!=nil { t.Fatal(err) }
	if _,err:=s.PrepareAccountMail(ctx,lease,fixtureActionURL);!errors.Is(err,domain.ErrNotFound) { t.Fatal("corrupt expired payload was not retired",err) }
	assertMailScrubbed(t,s,lease.ID,"expired")
	var revoked bool
	if err:=s.Pool.QueryRow(ctx,"SELECT revoked_at IS NOT NULL FROM account_action_tokens WHERE token_hash=$1",digest[:]).Scan(&revoked);err!=nil || !revoked { t.Fatal("expired job retained a live token",err) }
	if err:=s.QueueAccountMail(ctx,u.Email,store.ResetPasswordAction);err!=nil { t.Fatal("expired queue capacity not released",err) }
}

func TestAccountMailConcurrentClaimsAreExclusiveAcrossPools(t *testing.T) {
	s:=mailDB(t)
	ctx:=context.Background()
	u:=account(t,s,"mail-claim","tourist")
	if err:=s.QueueAccountMail(ctx,u.Email,store.VerifyEmailAction);err!=nil { t.Fatal(err) }
	other,err:=independentMailStore(t,s,fixtureMailKey)
	if err!=nil { t.Fatal(err) }
	var wg sync.WaitGroup
	results:=make(chan error,8)
	for i:=0;i<8;i++ {
		wg.Add(1)
		go func(index int){defer wg.Done();target:=s;if index%2==1 {target=other};_,e:=target.ClaimAccountMail(ctx);results<-e}(i)
	}
	wg.Wait();close(results)
	success:=0
	for err:=range results { if err==nil { success++ } else if !errors.Is(err,domain.ErrNotFound) { t.Fatal(err) } }
	if success!=1 { t.Fatal("the same job was leased concurrently",success) }
}

func TestRestrictedRuntimeCanQueuePrepareAcknowledgeAndCancelAccountMail(t *testing.T) {
	s:=mailDB(t)
	ctx:=context.Background()
	b:=make([]byte,24);if _,err:=rand.Read(b);err!=nil { t.Fatal(err) }
	secret:=hex.EncodeToString(b);role:="tropa_mail_"+secret[:12];quoted:=pgx.Identifier{role}.Sanitize()
	if _,err:=s.Pool.Exec(ctx,"CREATE ROLE "+quoted+" LOGIN PASSWORD '"+secret+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION");err!=nil { t.Fatal(err) }
	if err:=migrations.GrantRuntime(ctx,s.Pool,role);err!=nil { t.Fatal(err) }
	cfg:=s.Pool.Config();cfg.ConnConfig.User=role;cfg.ConnConfig.Password=secret
	pool,err:=pgxpool.NewWithConfig(ctx,cfg);if err!=nil { t.Fatal(err) }
	runtime:=&store.Store{Pool:pool}
	t.Cleanup(func(){runtime.Close();if _,err:=s.Pool.Exec(ctx,"DROP OWNED BY "+quoted);err!=nil {t.Error(err)};if _,err:=s.Pool.Exec(ctx,"DROP ROLE "+quoted);err!=nil {t.Error(err)}})
	if err=runtime.CheckRuntimeRole(ctx);err!=nil { t.Fatal(err) }
	if err=runtime.ConfigureAccountMail(ctx,fixtureMailKey);err!=nil { t.Fatal(err) }
	u,err:=runtime.RegisterWithAccountMail(ctx,"runtime-mail@example.invalid","fixture-hash","Mail fixture","tourist");if err!=nil { t.Fatal(err) }
	lease,message:=prepareMail(t,runtime)
	if err=runtime.FinishAccountMail(ctx,lease,true);err!=nil { t.Fatal(err) }
	if err=runtime.VerifyAccountEmail(ctx,mailActionDigest(t,message));err!=nil { t.Fatal(err) }
	if err=runtime.QueueAccountMail(ctx,u.Email,store.ResetPasswordAction);err!=nil { t.Fatal(err) }
	resetLease,resetMessage:=prepareMail(t,runtime)
	newHash:=strings.Repeat("runtime-mail-password",3)
	if _,err=runtime.ResetAccountPasswordWithMail(ctx,mailActionDigest(t,resetMessage),newHash);err!=nil { t.Fatal(err) }
	assertMailScrubbed(t,s,resetLease.ID,"cancelled")
	if err=runtime.DeleteAccount(ctx,u.ID,newHash);err!=nil { t.Fatal(err) }
	var pending int
	if err=s.Pool.QueryRow(ctx,"SELECT count(*) FROM account_mail_outbox WHERE payload_cipher IS NOT NULL").Scan(&pending);err!=nil || pending!=0 { t.Fatal("runtime closure retained mail payload",err) }
	if err=runtime.PruneAccountMail(ctx);err!=nil { t.Fatal(err) }
	if _,err=runtime.Pool.Exec(ctx,"UPDATE users SET is_admin=true WHERE id=$1",u.ID);err==nil { t.Fatal("mail grants elevated account privileges") }
	if _,err=runtime.Pool.Exec(ctx,"SELECT * FROM outbox_events");err==nil { t.Fatal("mail grants exposed unrelated domain events") }
}
