import {PGlite} from '@electric-sql/pglite';
import {postgis} from '@electric-sql/pglite-postgis';
import {PGLiteSocketServer} from '@electric-sql/pglite-socket';
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {copyFile,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// This isolated serial compatibility tool must never replace run-integration.sh.
const here = path.dirname(fileURLToPath(import.meta.url));
const options = {project:path.resolve(here,'../..'),suite:'serial',output:''};
for(let i=2;i<process.argv.length;i+=2){
  const name=process.argv[i]?.replace(/^--/,'');
  if(!['project','suite','output'].includes(name)||!process.argv[i+1])throw new Error('Usage: node run.mjs [--suite serial|auth] [--output directory] [--project repository]');
  options[name]=process.argv[i+1];
}
if(!['serial','auth'].includes(options.suite))throw new Error('Only the reviewed serial or auth selection is supported');
if(process.env.TEST_DATABASE_URL||process.env.TROPA_COMPAT_DATABASE_URL)throw new Error('Refusing an externally configured test database; this tool creates its own isolated WASM engine');
const output=options.output?path.resolve(options.output):await mkdtemp(path.join(tmpdir(),'tropnik-db-compat-report-'));
await mkdir(output,{recursive:true});
const work=await mkdtemp(path.join(tmpdir(),'tropnik-db-compat-work-'));
const backend=path.join(work,'backend');
const sourceSHA256={};
const selectedAuth=[
  'TestWasmRuntimeSQLGrantsAndMigrationReapply',
  'TestAuthenticationBudgetPersistsExpiresAndCleansBoundedly',
  'TestReadinessRequiresCurrentSchemaVersion',
];
const names=options.suite==='auth'?selectedAuth:[...selectedAuth,
  'TestReviewedRoutePolicyCannotBeWeakened',
  'TestGuideWithdrawalAndPrivateChat',
  'TestCompletionReviewsAndOfflineConflict',
  'TestRecruitmentDoesNotSilentlyBookTourists',
  'TestRealSessionsAndPendingGuide',
  'TestOverviewIsBoundedAndFullRouteRemainsAvailable',
  'TestRosterOnlyAssignedGuideAndRevokedInterestCannotPost',
  'TestModerationCaseScopeMuteAndIndependentAppeal',
];
async function copySources(relative=''){
  for(const entry of await readdir(path.join(options.project,'backend',relative),{withFileTypes:true})){
    const next=path.join(relative,entry.name);
    if(entry.name.startsWith('.')||['node_modules','vendor','dist','verification','build','bin'].includes(entry.name))continue;
    if(entry.isDirectory()){await copySources(next);continue;}
    if(!entry.isFile()||!(/\.(go|sql)$/.test(entry.name)||['go.mod','go.sum'].includes(entry.name)))continue;
    const from=path.join(options.project,'backend',next),to=path.join(backend,next);
    await mkdir(path.dirname(to),{recursive:true});
    await copyFile(from,to);
    sourceSHA256[`backend/${next.split(path.sep).join('/')}`]=createHash('sha256').update(await readFile(from)).digest('hex');
  }
}
async function cloneTest(name,replaceHelper=false){
  const source=path.join(backend,'internal/store',name);
  let raw=await readFile(source,'utf8');
  if(!raw.startsWith('//go:build integration\n'))throw new Error('Native integration build guard changed; manual harness review required');
  raw=raw.replace('//go:build integration','//go:build dbcompat');
  if(replaceHelper){
    const start=raw.indexOf('func TestMain('),end=raw.indexOf('func account(');
    if(start<0||end<=start)throw new Error('Native integration helper changed; refusing to rewrite test assertions');
    raw=raw.slice(0,start)+await readFile(path.join(here,'compat-helper.go.txt'),'utf8')+raw.slice(end);
  }
  await writeFile(source.replace('_integration_test.go','_dbcompat_test.go'),raw);
}
const logPath=path.join(output,'tests.jsonl');
let db,server,engine,exitCode=1,errorSummary;
try{
  await copySources();
  await cloneTest('postgres_integration_test.go',true);
  await cloneTest('moderation_integration_test.go');
  await cloneTest('auth_rate_integration_test.go');
  await copyFile(path.join(here,'role-compat-test.go.txt'),path.join(backend,'internal/store/role_dbcompat_test.go'));
  db=new PGlite({extensions:{postgis}});
  await db.waitReady;
  await db.exec('CREATE EXTENSION IF NOT EXISTS postgis');
  engine=(await db.query('SELECT version() AS postgres,postgis_full_version() AS postgis,current_database() AS database')).rows[0];
  server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1,inspect:false,debug:false});
  await server.start();
  const env={...process.env,TROPA_WASM_COMPAT:'1',TROPA_COMPAT_DATABASE_URL:`postgres://postgres@${server.getServerConn()}/postgres?sslmode=disable`};
  delete env.DATABASE_URL;
  delete env.TEST_DATABASE_URL;
  const log=createWriteStream(logPath);
  const args=['test','-count=1','-json','-tags=dbcompat','-run',`^(${names.join('|')})$`,'-timeout','120s','./internal/store'];
  console.log(JSON.stringify({stage:'serial_compatibility_started',selected:names.length,suite:options.suite,nativeGate:'not_run'}));
  // The child and socket intentionally share this process tree. No host DB,
  // operating-system UID change, public socket, or native root guard is used.
  const child=spawn(process.env.TROPA_GO||'go',args,{cwd:backend,env,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(log,{end:false});
  child.stderr.pipe(log,{end:false});
  const timer=setTimeout(()=>child.kill('SIGTERM'),180000);
  exitCode=await new Promise(resolve=>{
    child.on('close',code=>resolve(code??1));
    child.on('error',()=>resolve(1));
  });
  clearTimeout(timer);
  await new Promise(resolve=>log.end(resolve));
}catch(error){
  errorSummary=error instanceof Error?error.message:'compatibility setup failed';
  exitCode=1;
}finally{
  if(server)await server.stop();
  if(db)await db.close();
  await rm(work,{recursive:true,force:true});
}
const events=[];
try{for(const line of (await readFile(logPath,'utf8')).split('\n')){try{events.push(JSON.parse(line));}catch{}}}catch{}
const passed=events.filter(e=>e.Action==='pass'&&names.includes(e.Test)).map(e=>e.Test);
const failed=events.filter(e=>e.Action==='fail').map(e=>e.Test||e.Package);
const skipped=events.filter(e=>e.Action==='skip').map(e=>e.Test||e.Package);
const missing=names.filter(name=>!passed.includes(name));
const success=exitCode===0&&missing.length===0&&failed.length===0&&skipped.length===0&&events.some(e=>e.Action==='pass'&&!e.Test);
const result={
  recordedAt:new Date().toISOString(),suite:options.suite,success,exitCode,engine,
  selectedTests:names,passedTests:passed,failedTests:failed,skippedTests:skipped,missingTests:missing,
  errorSummary,sourceSHA256,nativePostgresGate:'not_run',
  scope:'Experimental PostGIS in a single-session WASM engine. SQL and SET ROLE grants only; not native concurrency, network role authentication, SCRAM, TLS, deployment, or production PostGIS 3.7 validation.',
};
await writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({stage:'serial_compatibility_finished',success,passed:passed.length,selected:names.length,report:path.join(output,'result.json')}));
process.exitCode=success?0:1;
