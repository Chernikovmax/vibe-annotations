// Real optional permission + capture/crop boundary. Isolated profile, no MCP.
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const require = createRequire(join(process.env.ANGULAR_DEPS || '/tmp/va-stage1-ng20','package.json'));
const { chromium } = require('playwright');
const extension = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// PROFILE may reuse an explicitly isolated test directory while investigating failures.
const profile = process.env.PROFILE || await mkdtemp(join(tmpdir(),'va-capture-geometry-'));
const dpr = Number(process.env.DPR || 1);
const palette = [[210,30,70],[30,180,90],[40,90,220],[230,170,20],[130,50,210],[20,180,190],[225,100,40],[110,130,150]];
const cells = Array.from({length:350},(_,i)=>{const x=i%14,y=Math.floor(i/14),c=palette[(x+3*y)%palette.length];return `<div style="position:absolute;left:${x*80}px;top:${y*80}px;width:80px;height:80px;background:rgb(${c})"></div>`;}).join('');
const server = createServer((_req,res)=>res.end(`<!doctype html><style>body{margin:0;height:2000px;overflow-x:hidden}button{border:0;padding:0}#target{position:fixed;left:170px;top:170px;width:120px;height:90px;background:rgb(240,80,20)}#sticky{position:sticky;top:55px;left:760px;margin-left:760px;width:100px;height:60px;background:rgb(30,160,230)}</style>${cells}<button id="target" aria-label="Fixed color marker"></button><button id="sticky" aria-label="Sticky color marker"></button>`));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser,worker,page;
const errors=[];
let captureTimeout=120000;
const status=()=>page.locator('.vibe-attachment-status');
const startCapture=async mode=>{await worker.evaluate(async()=>{const window=await chrome.windows.getCurrent();await chrome.windows.update(window.id,{focused:true});});await page.bringToFront();await page.waitForTimeout(650);await page.locator('.vibe-add-btn').click();await page.locator(`[data-add="${mode}"]`).click();};
const finishCapture=async before=>{await page.waitForFunction(n=>{const root=document.querySelector('#vibe-annotations-root')?.shadowRoot;return root?.querySelectorAll('.vibe-att-tile').length>n||/cancelled|outside|changed|fail|error|unavailable/i.test(root?.querySelector('.vibe-attachment-status')?.textContent||'');},before,{timeout:captureTimeout}); assert.ok(await page.locator('.vibe-att-tile').count()>before,await status().textContent());await status().filter({hasText:'Saved locally'}).waitFor();};
const assertRestored=async()=>{assert.equal(await page.locator('.vibe-popover').isVisible(),true);assert.equal(await page.locator('.vibe-add-btn').isEnabled(),true);assert.equal(await page.locator('.vibe-textarea').inputValue(),'Geometry draft must survive');assert.equal(await page.locator('#vibe-annotations-root').evaluate(el=>el.style.visibility),'');};
const readLast=()=>worker.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('vibe-annotations-local-attachments');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});const all=await new Promise((resolve,reject)=>{const r=db.transaction('attachments').objectStore('attachments').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();const item=all.sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at)).at(-1);const bitmap=await createImageBitmap(item.blob);const canvas=new OffscreenCanvas(bitmap.width,bitmap.height);const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;return {id:item.id,width:item.width,height:item.height,pixels:Array.from(data)};});
const assertImage=(image,box,scale,expected)=>{assert.ok(Math.abs(image.width-box.width*scale)<=2,`width ${image.width}, expected ${box.width*scale}`);assert.ok(Math.abs(image.height-box.height*scale)<=2,`height ${image.height}, expected ${box.height*scale}`);for(const [x,y] of [[10,10],[35,35],[70,60],[100,70]]){if(x>=box.width||y>=box.height)continue;const px=Math.min(image.width-1,Math.floor(x*scale)),py=Math.min(image.height-1,Math.floor(y*scale));const actual=image.pixels.slice((py*image.width+px)*4,(py*image.width+px)*4+3);const rgb=expected(box.left+x,box.top+y);assert.ok(actual.every((v,i)=>Math.abs(v-rgb[i])<38),`marker CSS(${box.left+x},${box.top+y}) actual ${actual} expected ${rgb}`);}};
try{
  const unpacked=join(extension,'.output/chrome-mv3');
  if(process.env.PROFILE) await rm(join(profile,'Default','Service Worker'),{recursive:true,force:true});
  browser=await chromium.launchPersistentContext(profile,{headless:!process.env.HEADED,channel:'chromium',ignoreDefaultArgs:process.env.NORMAL_PERMISSIONS?['--enable-automation']:[],viewport:{width:1000,height:740},deviceScaleFactor:dpr,args:[`--disable-extensions-except=${unpacked}`,`--load-extension=${unpacked}`,`--force-device-scale-factor=${dpr}`]});
  worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker');
  await worker.evaluate(()=>{const native=fetch;globalThis.fetch=(url,...args)=>/^https?:/.test(String(url))?Promise.reject(new Error('Offline geometry fixture')):native(url,...args);});
  console.log('Initial host permissions',JSON.stringify(await worker.evaluate(()=>chrome.permissions.getAll())));
  page=await browser.newPage();page.setDefaultTimeout(120000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.waitForFunction(()=>window.__vibeAnnotations);await page.bringToFront();
  await page.locator('.vibe-tb-annotate').click();await page.locator('#target').click();await page.locator('.vibe-textarea').fill('Geometry draft must survive');
  if(process.env.DENIAL){console.log('PERMISSION: deny the first optional all-sites request in Chromium');await startCapture('shot');await status().filter({hasText:'not granted'}).waitFor();await assertRestored();console.log('PASS real permission denial preserves text and UI');}
  console.log('PERMISSION: allow the optional all-sites request in Chromium');await startCapture('shot');await finishCapture(0);await assertRestored();
  page.setDefaultTimeout(15000);
  captureTimeout=15000;
  const tabId=await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({active:true,lastFocusedWindow:true});return tabs[0].id;});
  for(const zoom of [0.8,1,1.25]){
    await worker.evaluate(({id,zoom})=>chrome.tabs.setZoom(id,zoom),{id:tabId,zoom});await page.waitForTimeout(300);
    for(const scroll of [0,240]){
      console.log(`Capturing grid DPR=${dpr} zoom=${zoom} scroll=${scroll}`);
      await page.evaluate(y=>scrollTo(0,y),scroll);await page.waitForTimeout(150);
      const count=await page.locator('.vibe-att-tile').count();await startCapture('region');await page.locator('.vibe-region-shade').waitFor();
      await page.mouse.move(400,280);await page.mouse.down();await page.mouse.move(560,400,{steps:4});await page.mouse.up();
      try { await finishCapture(count); } catch(error) { console.error('CAPTURE STATUS',await status().count()?await status().textContent():'card removed'); throw error; }
      const image=await readLast();const scale=await page.evaluate(()=>devicePixelRatio);const sy=await page.evaluate(()=>scrollY);
      assertImage(image,{left:400,top:280,width:160,height:120},scale,(x,y)=>palette[(Math.floor(x/80)+3*Math.floor((y+sy)/80))%palette.length]);
      console.log(`PASS grid DPR=${dpr} browserZoom=${zoom} actualDPR=${scale} scroll=${scroll} bitmap=${image.width}x${image.height}`);
      await page.waitForTimeout(450);
    }
  }
  await worker.evaluate(id=>chrome.tabs.setZoom(id,1),tabId);await page.waitForTimeout(250);await page.evaluate(()=>scrollTo(0,0));
  const cdp=await browser.newCDPSession(page);await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:1.5});await page.waitForTimeout(250);
  const beforePinch=await page.locator('.vibe-att-tile').count();await startCapture('region');await page.locator('.vibe-region-shade').waitFor();
  await page.mouse.move(400,280);await page.mouse.down();await page.mouse.move(560,400,{steps:4});
  const pinchBox=await page.locator('.vibe-region-rect').evaluate(el=>({left:parseFloat(el.style.left),top:parseFloat(el.style.top),width:parseFloat(el.style.width),height:parseFloat(el.style.height)}));
  await page.mouse.up();await finishCapture(beforePinch);
  const pinch=await page.evaluate(()=>({scale:devicePixelRatio*visualViewport.scale,scroll:scrollY}));
  assertImage(await readLast(),pinchBox,pinch.scale,(x,y)=>palette[(Math.floor(x/80)+3*Math.floor((y+pinch.scroll)/80))%palette.length]);
  console.log(`PASS visualViewport pinch scale=1.5 DPR=${dpr}`);
  await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:1});await cdp.detach();await page.waitForTimeout(250);
  await worker.evaluate(id=>chrome.tabs.setZoom(id,1),tabId);await page.waitForTimeout(250);await page.evaluate(()=>scrollTo(0,240));
  for(const target of ['target','sticky']){
    await page.locator('.vibe-cancel-btn').click();await page.locator('.vibe-popover').waitFor({state:'detached'});const annotate=page.locator('.vibe-tb-annotate');if(await annotate.isVisible())await annotate.click();await page.locator(`#${target}`).click();await page.locator('.vibe-textarea').fill('Geometry draft must survive');
    const r=await page.locator(`#${target}`).boundingBox();await startCapture('shot');await finishCapture(0);const image=await readLast();const scale=await page.evaluate(()=>devicePixelRatio);const box={left:r.x-16,top:r.y-16,width:r.width+32,height:r.height+32};const rgb=target==='target'?[240,80,20]:[30,160,230];
    // These markers are safely inside the known fixed/sticky element, not text/antialiased borders.
    assert.ok(Math.abs(image.width-box.width*scale)<=2);assert.ok(Math.abs(image.height-box.height*scale)<=2);for(const [x,y] of [[24,24],[45,40],[70,55]]){const p=(Math.floor(y*scale)*image.width+Math.floor(x*scale))*4;assert.ok(image.pixels.slice(p,p+3).every((v,i)=>Math.abs(v-rgb[i])<38));}
    console.log(`PASS ${target} element on scrolled grid DPR=${dpr}`);
  }
  if(process.env.RACES){
    for(const race of ['tab','window','scroll','zoom','decode']){
      const before=await page.locator('.vibe-att-tile').count();
      await worker.evaluate(({race,id})=>{const native=chrome.tabs.captureVisibleTab.bind(chrome.tabs);chrome.tabs.captureVisibleTab=async(...args)=>{chrome.tabs.captureVisibleTab=native;const result=await native(...args);if(race==='tab'){const other=await chrome.tabs.create({url:'about:blank',active:true});await chrome.tabs.update(id,{active:true});await chrome.tabs.remove(other.id);}if(race==='window'){const current=await chrome.windows.getLastFocused();const other=await chrome.windows.create({url:'about:blank',focused:true});await chrome.windows.update(current.id,{focused:true});await chrome.windows.remove(other.id);}if(race==='scroll'){await chrome.scripting.executeScript({target:{tabId:id},func:async()=>{const y=scrollY;scrollTo(0,y+30);await new Promise(r=>requestAnimationFrame(r));scrollTo(0,y);await new Promise(r=>requestAnimationFrame(r));}});}if(race==='zoom'){await chrome.tabs.setZoom(id,0.9);await chrome.tabs.setZoom(id,1);}return race==='decode'?'data:image/png;base64,AAAA':result;};},{race,id:tabId});
      await startCapture('shot');await status().filter({hasText:/cancelled|decoded|source image|image could/i}).waitFor();await page.bringToFront();await assertRestored();assert.equal(await page.locator('.vibe-att-tile').count(),before,`${race} cannot publish an attachment`);console.log(`PASS ${race} in-flight failure rejects and restores UI`);
    }
    await startCapture('region');await page.locator('.vibe-region-shade').waitFor();await page.keyboard.press('Escape');await status().filter({hasText:'cancelled'}).waitFor();await assertRestored();
  }
  assert.deepEqual(errors,[],'no uncaught page errors');console.log(`PASS capture geometry matrix DPR=${dpr}`);
}finally{await browser?.close();await new Promise(r=>server.close(r));if(!process.env.PROFILE)await rm(profile,{recursive:true,force:true});}
