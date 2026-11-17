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

function twoFiles(dir,value){
 const files=generation(dir,value),bytes=Buffer.from(`export default ${JSON.stringify(value+'-workflow')};`);
 fs.writeFileSync(path.join(dir,'workflows.mjs'),bytes);files['workflows.mjs']={size:bytes.length,sha256:sha(bytes)};
 fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({files}));return files;
}
it('a persistent second-file rename EPERM leaves that file untouched and restores earlier successful writes',()=>{
 const {stage,output}=fixture();twoFiles(output,'previous');const files=twoFiles(stage,'replacement');
 const oldSecond=fs.readFileSync(path.join(output,'workflows.mjs')),oldManifest=fs.readFileSync(path.join(output,'manifest.json'));
 const failure=Object.assign(Error('persistent second-file EPERM'),{code:'EPERM'}),targets=[];let thrown;
 try{publishHost(stage,output,files,{rename:(from,to)=>{targets.push(path.basename(to));if(path.basename(to)==='workflows.mjs')throw failure;fs.renameSync(from,to);}});}catch(error){thrown=error;}
 expect(thrown).toBe(failure);expect(fs.readFileSync(path.join(output,'workflows.mjs'))).toEqual(oldSecond);
 expect(fs.readFileSync(path.join(output,'manifest.json'))).toEqual(oldManifest);expect(fresh(output)).toBe('previous');
 expect(targets.filter(name=>name==='workflows.mjs')).toHaveLength(1);
 expect(fs.readdirSync(output).some(name=>name.endsWith('.build-tmp'))).toBe(false);
});
it('a rollback failure is reported with the publication error and does not prevent restoring earlier files',()=>{
 const {stage,output}=fixture();twoFiles(output,'previous');const files=twoFiles(stage,'replacement');
 const oldRuntime=fs.readFileSync(path.join(output,'runtime.mjs')),oldManifest=fs.readFileSync(path.join(output,'manifest.json'));
 const failure=Object.assign(Error('manifest is persistently locked'),{code:'EPERM'}),rollback=Object.assign(Error('workflow rollback is persistently locked'),{code:'EPERM'});let workflowWrites=0,thrown;
 try{publishHost(stage,output,files,{rename:(from,to)=>{const name=path.basename(to);if(name==='manifest.json')throw failure;if(name==='workflows.mjs'&&++workflowWrites===2)throw rollback;fs.renameSync(from,to);}});}catch(error){thrown=error;}
 expect(thrown).toBeInstanceOf(AggregateError);expect(thrown.cause).toBe(failure);expect(thrown.errors).toEqual([failure,rollback]);
 expect(thrown.message).toContain('workflows.mjs');expect(fs.readFileSync(path.join(output,'runtime.mjs'))).toEqual(oldRuntime);
 expect(fs.readFileSync(path.join(output,'manifest.json'))).toEqual(oldManifest);expect(fs.readFileSync(path.join(output,'workflows.mjs'))).toEqual(fs.readFileSync(path.join(stage,'workflows.mjs')));
 expect(workflowWrites).toBe(2);expect(fs.readdirSync(output).some(name=>name.endsWith('.build-tmp'))).toBe(false);
});
