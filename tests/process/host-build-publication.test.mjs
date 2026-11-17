import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {afterEach,expect,it} from 'vitest';
import {publishHost} from '../../tools/publish-host.mjs';
const dirs=[];
afterEach(()=>{for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'host-publication 世界-'));dirs.push(root);const stage=path.join(root,'stage'),output=path.join(root,'host');fs.mkdirSync(stage);fs.mkdirSync(output);return {root,stage,output};}
function generation(dir,value){const bytes=Buffer.from(`export default ${JSON.stringify(value)};`);fs.writeFileSync(path.join(dir,'runtime.mjs'),bytes);const files={'runtime.mjs':{size:bytes.length,sha256:sha(bytes)}};fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({files}));return files;}
function fresh(output){return execFileSync(process.execPath,['--input-type=module','-e','const fs=await import("node:fs");const {pathToFileURL}=await import("node:url");const {createHash}=await import("node:crypto");const p=process.argv[1];const m=JSON.parse(fs.readFileSync(p+"/manifest.json"));for(const [name,x]of Object.entries(m.files))if(createHash("sha256").update(fs.readFileSync(p+"/"+name)).digest("hex")!==x.sha256)throw Error("inventory mismatch");console.log((await import(pathToFileURL(p+"/runtime.mjs"))).default);',output],{encoding:'utf8'}).trim();}
it('a mid-publication failure restores the previous inventory and runtime for a fresh process',()=>{
 const {stage,output}=fixture();generation(output,'previous');const files=generation(stage,'replacement');let calls=0;
 expect(()=>publishHost(stage,output,files,{rename:(...args)=>{if(++calls===2)throw Object.assign(Error('locked file'),{code:'EPERM'});return fs.renameSync(...args);}})).toThrow('locked file');
 expect(fresh(output)).toBe('previous');
 publishHost(stage,output,files);expect(fresh(output)).toBe('replacement');
});
it('a failed staged build leaves the published generation unchanged',()=>{
 const {stage,output}=fixture();generation(output,'previous');fs.writeFileSync(path.join(stage,'incomplete.mjs'),'broken');
 expect(fresh(output)).toBe('previous');
});
it('a physically loaded native addon is reused unchanged; changed native bytes refuse before touching old artifacts',async()=>{
 const {stage,output}=fixture();const old=generation(output,'previous'),files=generation(stage,'replacement');
 const source=path.resolve('dist/host/node_modules/better-sqlite3/build/Release/better_sqlite3.node');
 const name='native.node';fs.copyFileSync(source,path.join(output,name));fs.copyFileSync(source,path.join(stage,name));
 const bytes=fs.readFileSync(source);old[name]={size:bytes.length,sha256:sha(bytes)};files[name]=old[name];
 fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify({files:old}));fs.writeFileSync(path.join(stage,'manifest.json'),JSON.stringify({files}));
 const child=spawn(process.execPath,['-e','require(process.argv[1]);process.stdout.write("ready");setInterval(()=>{},1000);',path.join(output,name)],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 try{
  await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',resolve);child.once('exit',code=>reject(Error('native owner exited '+code)));});
  publishHost(stage,output,files);expect(fresh(output)).toBe('replacement');
  fs.writeFileSync(path.join(stage,name),Buffer.from('different native bytes'));const changed={...files,[name]:{size:22,sha256:sha(Buffer.from('different native bytes'))}};
  expect(()=>publishHost(stage,output,changed)).toThrow(/stop owners/);expect(fresh(output)).toBe('replacement');
  console.log(JSON.stringify({nativeLockFixture:{pid:child.pid,module:path.join(output,name),source}}));
 }finally{const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}
});
