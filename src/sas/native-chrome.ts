import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium, type Browser, type BrowserContext } from 'playwright';

export function chromeExecutable(platform = process.platform, env = process.env): string {
  const candidates = platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(homedir(),'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ] : platform === 'win32' ? ['PROGRAMFILES','PROGRAMFILES(X86)','LOCALAPPDATA']
    .filter(key=>env[key]).map(key=>join(env[key]!, 'Google','Chrome','Application','chrome.exe')) : [];
  if(platform !== 'darwin' && platform !== 'win32') {
    for(const name of ['google-chrome','google-chrome-stable','chromium']) {
      try { candidates.push(execFileSync('which',[name],{encoding:'utf8'}).trim()); } catch {}
    }
  }
  const executable=candidates.find(p=>p && existsSync(p));
  if(!executable) throw new Error('CHROME_NOT_FOUND');
  return executable;
}
async function availablePort(): Promise<number> {
  const server=createServer();
  return new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{
      const address=server.address();
      if(!address || typeof address==='string') {server.close();reject(new Error('PORT_UNAVAILABLE'));return;}
      server.close(error=>error?reject(error):resolve(address.port));
    });
  });
}
// Airline sites refuse Chrome's own headless user agent, and Asiana skips wiring
// up part of its form unless navigator.webdriver is false — which launching Chrome
// ourselves and attaching over CDP gives us, unlike a Playwright-launched browser.
export const NATIVE_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

export function chromeArguments(profile: string, port: number, options: {headless?: boolean; userAgent?: string} = {}): string[] {
  if(!Number.isInteger(port) || port<1024 || port>65535) throw new Error('INVALID_PORT');
  const extra = [
    ...(options.headless ? ['--headless=new', '--window-size=1440,1100'] : ['--new-window']),
    ...(options.userAgent ? [`--user-agent=${options.userAgent}`] : []),
  ];
  return [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check', ...extra, 'about:blank'];
}
/** Reads Chrome's SingletonLock ("host-pid") and ends the instance holding this
 *  profile — but only after `ps` confirms the pid really is a Chrome started on
 *  this exact profile, so a recycled pid is never the one that gets killed. */
export async function releaseProfile(profile: string): Promise<number | null> {
  let pid: number;
  try { pid = Number(readlinkSync(join(profile,'SingletonLock')).split('-').pop()); } catch { return null; }
  if(!Number.isInteger(pid) || pid<=1) return null;
  try {
    const command=execFileSync('ps',['-o','command=','-p',String(pid)],{encoding:'utf8'});
    if(!command.includes(`--user-data-dir=${profile}`)) return null;
  } catch { return null; }
  try { process.kill(pid); } catch { return null; }
  // Chrome only releases the lock once it has finished shutting down; spawning
  // before that just loses the profile to the instance on its way out.
  for(let waited=0; waited<4000; waited+=100) {
    try { process.kill(pid,0); } catch { return pid; }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  return pid;
}
export async function openNativeChrome(profile: string, options:{keepRunning?:boolean;headless?:boolean;userAgent?:string}={}): Promise<{browser:Browser,context:BrowserContext,process:ChildProcess|null,close:()=>Promise<void>}> {
  mkdirSync(profile,{recursive:true});
  const endpointFile=join(profile,'local-debug-endpoint.json');
  const signature=`${options.headless?'headless':'windowed'}|${options.userAgent??''}`;
  // Chrome refuses to start a second instance on a profile another one holds: it
  // hands the request over and exits, which reads here as CHROME_OPEN_FAILED. A
  // worker killed outright leaves exactly such an instance behind, and every
  // later scan failed against it until the machine was rebooted. So a live
  // instance on this profile is reused whatever it was started for — with its
  // pid remembered, since a CDP connection's close() only disconnects.
  try{
    const saved=JSON.parse(readFileSync(endpointFile,'utf8')) as {endpoint:string;pid?:number;signature?:string};
    const endpoint=new URL(saved.endpoint);
    if(endpoint.protocol==='ws:'&&endpoint.hostname==='127.0.0.1'&&(saved.signature??signature)===signature){
      const current=await fetch(`http://127.0.0.1:${endpoint.port}/json/version`,{signal:AbortSignal.timeout(1000)}).then(r=>r.json()) as {webSocketDebuggerUrl?:string};
      if(current.webSocketDebuggerUrl===saved.endpoint){
        const browser=await chromium.connectOverCDP(saved.endpoint,{timeout:5000});const context=browser.contexts()[0];
        if(context)return {browser,context,process:null,close:async()=>{
          await browser.close().catch(()=>{});
          if(!options.keepRunning&&saved.pid)try{process.kill(saved.pid);}catch{}
        }};
        await browser.close();
      }
    }
  }catch{}
  // An instance from before this file was written leaves no endpoint to reuse,
  // only Chrome's own SingletonLock naming the process that holds the profile.
  // It is killed rather than worked around: it answers no debugging port, so
  // nothing can reach it, and while it lives nothing else can start here.
  await releaseProfile(profile);
  const port=await availablePort();
  const child=spawn(chromeExecutable(),chromeArguments(profile,port,{headless:options.headless,userAgent:options.userAgent}),{stdio:'ignore',windowsHide:false});
  let spawnError=false;child.once('error',()=>{spawnError=true;});
  let browser:Browser|undefined;
  try {
    const deadline=Date.now()+20000;
    let endpoint='';
    while(Date.now()<deadline) {
      if(spawnError || child.exitCode!==null) throw new Error('CHROME_OPEN_FAILED');
      try {
        const response=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1000)});
        const data=await response.json() as {webSocketDebuggerUrl?:string};
        if(data.webSocketDebuggerUrl && new URL(data.webSocketDebuggerUrl).hostname==='127.0.0.1') {endpoint=data.webSocketDebuggerUrl;break;}
      } catch {}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    if(!endpoint) throw new Error('CHROME_CONNECTION_FAILED');
    writeFileSync(endpointFile,JSON.stringify({endpoint,pid:child.pid,signature}),{mode:0o600});
    browser=await chromium.connectOverCDP(endpoint,{timeout:10000});
    const context=browser.contexts()[0];
    if(!context) throw new Error('CHROME_CONNECTION_FAILED');
    const connection=browser;
    return {browser,context,process:child,close:async()=>{
      await connection.close().catch(()=>{});
      if(!options.keepRunning&&child.exitCode===null)child.kill();
    }};
  } catch(error) {
    await browser?.close().catch(()=>{});
    if(child.exitCode===null)child.kill();
    throw error;
  }
}
