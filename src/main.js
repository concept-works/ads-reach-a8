'use strict';
const {app,BrowserWindow,dialog,ipcMain}=require('electron');
const fs=require('fs');const path=require('path');const {execFileSync}=require('child_process');
const {chromium}=require('playwright-core');
const cheerio=require('cheerio');
app.setName('ADS-REACH-A8');
const CARD='#wrapper div.inner .section:not(#searchTop) .pgCard';
const LIST_DELAY=3000;
const DETAIL_DELAY=1000;
const SEARCH_API='https://media-console.a8.net/api/v1/user/program/search';
const PAGE_SIZE=100;
const HTTP_TIMEOUT=45000;
const HEADERS=['プラグラム名','プログラムID','成果報酬','EPC','確定率','リスティングOK','リスティング一部OK','リスティングNG','カテゴリ','商品リンク','リスティングNGキーワード'];
let win,ctx,page,rows=[],running=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function update(message,percent,stage){if(win&&!win.isDestroyed())win.webContents.send('progress',{message,percent,stage});}
function macPids(profile){if(process.platform!=='darwin')return [];try{return execFileSync('/bin/ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n').map(s=>s.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean).filter(m=>m[2].includes(profile)).map(m=>Number(m[1])).filter(x=>x!==process.pid);}catch{return [];}}
function cleanupProfile(profile){if(process.platform!=='darwin')return;for(const pid of macPids(profile)){try{process.kill(pid,'SIGTERM')}catch{}}for(const p of ['SingletonLock','SingletonCookie','SingletonSocket']){try{fs.unlinkSync(path.join(profile,p))}catch{}}}
async function closeBrowser(){if(ctx){try{await ctx.close()}catch{}}ctx=null;page=null;}
async function launch(){if(page&&!page.isClosed())return;let error;
 for(const channel of ['chrome','msedge']){
  const profile=path.join(app.getPath('userData'),'a8-browser-'+channel);fs.mkdirSync(profile,{recursive:true});
  try{
   // On macOS, remove orphaned browser processes from this app's isolated profile before startup.
   cleanupProfile(profile);
   ctx=await chromium.launchPersistentContext(profile,{channel,headless:false,viewport:null,...(process.platform==='darwin'?{}:{args:['--start-maximized']})});
   page=ctx.pages()[0]||await ctx.newPage();update(channel==='chrome'?'Chromeを起動しました':'Edgeを起動しました');return;
  }catch(e){error=e;cleanupProfile(profile);ctx=null;page=null;}
 }
 throw Error('ChromeまたはEdgeを起動できません。インストールを確認してください。 '+(error?.message||''));
}
const clean=v=>String(v??'').replace(/\s+/g,' ').trim();
function parseListing(badges,cardText){const b=badges.join(' / ');const t=clean(cardText);
 // Strict precedence prevents partial acceptance being mislabeled as full approval.
 if(/リスティング(?:広告)?(?:不可|禁止|NG|ＮＧ)/i.test(b)||/リスティング(?:広告)?(?:不可|禁止|NG|ＮＧ)/i.test(t.match(/リスティング[^\s、。]{0,20}/)?.[0]||''))return 'NG';
 if(/リスティング(?:広告)?(?:一部|条件|制限)|リスティング一部可/i.test(b)||/リスティング(?:広告)?(?:一部|条件|制限)/i.test(t.match(/リスティング[^\s、。]{0,20}/)?.[0]||''))return 'PART';
 if(/リスティング(?:広告)?(?:可|OK|ＯＫ|許可)/i.test(b))return 'OK';
 return ''; // Unknown is NOT assumed OK.
}
async function extractCard(index){return page.locator(CARD).nth(index).evaluate(el=>{
 const c=v=>(v||'').replace(/\s+/g,' ').trim();const values={};
 el.querySelectorAll('div.pgContent div.pgRight div.tableWrapper table.tableVertical tr').forEach(tr=>{const k=c(tr.querySelector('th')?.textContent),v=c(tr.querySelector('td')?.textContent);if(k)values[k]=v});
 const get=label=>values[label]||values[Object.keys(values).find(k=>k.includes(label))]||'';
 const badges=[...el.querySelectorAll('div.pgBadge img')].map(x=>c(x.getAttribute('alt'))).filter(Boolean);
 const badgeTitles=[...el.querySelectorAll('div.pgBadge [title], div.pgBadge [aria-label]')].map(x=>c(x.getAttribute('title')||x.getAttribute('aria-label'))).filter(Boolean);
 const detail=el.querySelector('a[data-gtm-click="program_detail_link_navigate"], a[href*="/program/detail-"]');
 return {name:c(el.querySelector('h3.pgName')?.textContent),id:get('プログラムID'),reward:get('成果報酬'),epc:get('EPC'),rate:get('確定率'),category:get('カテゴリ'),badges:[...badges,...badgeTitles],cardText:c(el.innerText||''),product:badges.includes('商品リンク')||/MyLink利用可能|商品リンク利用可能|商品リンク対応|どこでもリンクあり/i.test(el.innerText||''),detailHref:detail?.getAttribute('href')||''};
 });}
async function getNgWords(index,href){
 if(!href)throw Error('詳細ページリンクがありません');
 const before=page.url();
 const target=new URL(href,before).href;
 const detailSelector='div.pgDetail .pgInnerBottom';
 const visibleDetail=()=>page.locator(detailSelector).first().isVisible().catch(()=>false);
 try{
  // A8 may trigger slow SPA/full-document navigation. A click can already succeed
  // while Playwright is still waiting for scheduled navigations to settle.
  // noWaitAfter prevents a successful click from being reported as a click failure.
  const link=page.locator(CARD).nth(index).locator('a[data-gtm-click="program_detail_link_navigate"], a[href*="/program/detail-"]').first();
  try{
   await link.click({timeout:20000,noWaitAfter:true});
  }catch(e){
   if(!await visibleDetail() && page.url()===before)throw Error('詳細リンクをクリックできません: '+e.message);
  }
  try{
   await page.locator(detailSelector).first().waitFor({state:'visible',timeout:45000});
  }catch(e){
   // If the click did not navigate, open the exact href from the current card.
   // Do not initiate a second navigation if the detail page is already open.
   if(await visibleDetail()){}else if(page.url()===before){
    update('詳細ページの応答が遅いため、同じリンクを直接開いて再確認します');
    await page.goto(target,{waitUntil:'domcontentloaded',timeout:60000});
    await page.locator(detailSelector).first().waitFor({state:'visible',timeout:45000});
   }else throw Error('詳細ページ表示待機に失敗: '+e.message);
  }
  await sleep(LIST_DELAY);
  return await page.locator('div.pgDetail .pgInnerBottom tr').evaluateAll(trs=>{
   for(const tr of trs){const th=(tr.querySelector('th')?.textContent||'').replace(/\s/g,'').normalize('NFKC');
    if(th.includes('リスティングNGワード')){
     const el=tr.querySelector('td .preText')||tr.querySelector('td');
     return {found:true,value:(el?.innerText||el?.textContent||'').replace(/\r\n?/g,'\n').trim()};
    }
   }return {found:false,value:''};
  });
 }finally{
  try{
   if(page.url()!==before){
    try{await page.goBack({waitUntil:'domcontentloaded',timeout:45000});}
    catch(e){
     if(page.url()!==before)await page.goto(before,{waitUntil:'domcontentloaded',timeout:60000});
    }
   }
   await page.locator(CARD).first().waitFor({state:'visible',timeout:45000});
  }catch(e){throw Error('一覧ページへの復帰に失敗: '+e.message)}
  await sleep(LIST_DELAY);
 }
}
async function setupList(){const count=await page.locator(CARD).count();if(count)return;
 const search=page.locator('#headerKeywordSearchForm > button');if(!await search.count())throw Error('A8にログイン後、トップページまたは案件一覧を開いてください。');
 await search.click();await page.locator(CARD).first().waitFor({state:'visible',timeout:30000});}
async function cardKey(){
 const card=page.locator(CARD).first();if(!await card.count())return '';
 return card.evaluate(el=>{const tr=[...el.querySelectorAll('table.tableVertical tr')].find(t=>(t.querySelector('th')?.textContent||'').includes('プログラムID'));
 return ((tr?.querySelector('td')?.textContent||'')+'|'+(el.querySelector('h3.pgName')?.textContent||'')).trim();});
}
async function nextListPage(currentPage){
 const next=page.locator('div.toolbarBottom nav.pager ul.pagerList li button.pagerNext').first();
 if(!await next.count()||await next.isDisabled().catch(()=>true)||await next.getAttribute('disabled')!==null||await next.getAttribute('aria-disabled')==='true')return false;
 const before=await cardKey();
 update(`${currentPage}ページ目が完了。次ページへ移動します`);
 await next.click({timeout:15000});
 await page.waitForFunction(({selector,previousKey})=>{
  const first=document.querySelector(selector);if(!first)return false;
  const tr=[...first.querySelectorAll('table.tableVertical tr')].find(t=>(t.querySelector('th')?.textContent||'').includes('プログラムID'));
  const now=((tr?.querySelector('td')?.textContent||'')+'|'+(first.querySelector('h3.pgName')?.textContent||'')).trim();
  return now&&now!==previousKey;
 },{selector:CARD,previousKey:before},{timeout:30000});
 await sleep(LIST_DELAY);return true;
}
async function getTotal(){
 const el=page.locator('#pgTop > div.resultControlBar.resultControlFlex > div.resultCount > span.count').first();
 try {const raw=await el.innerText({timeout:10000});const n=Number(raw.replace(/[^0-9]/g,''));return Number.isSafeInteger(n)&&n>0?n:null;}catch{return null;}
}
async function logoutAndClose(){
 let warning='';
 try{
  if(page&&!page.isClosed()){
   update('A8.netからログアウトしています…');
   // The logout anchor may remain hidden in a responsive header. The original
   // link calls document.getElementById('logoutFormHeader').submit().
   // Submit the native form rather than waiting for that anchor to be visible.
   const form=page.locator('form#logoutFormHeader');
   if(await form.count()===0){
    warning='ログアウト用フォームが見つかりませんでした。ログアウト状態は未確認です';
   }else{
    const before=page.url();
    await form.evaluate(el=>el.submit());
    try{
     await page.waitForURL(url=>url.href!==before,{timeout:15000,waitUntil:'domcontentloaded'});
    }catch(e){
     warning='ログアウトフォームは送信しましたが、ページ遷移を確認できませんでした';
    }
    if(!warning){
     // A different URL is not necessarily proof that the session was invalidated.
     update('ログアウトフォームを送信し、ページ遷移を確認しました');
    }
   }
  }
 }catch(e){warning='ログアウト処理に失敗しました: '+e.message}
 finally{
  if(warning)update('※'+warning);
  update('ブラウザを閉じています…');await closeBrowser();
 }
 return warning;
}
// Two independent phases: collect all list cards before opening any detail URL.
// A local checkpoint is updated during detail processing to protect long-running jobs.
function checkpointPath(){return path.join(app.getPath('userData'),'a8-two-phase-checkpoint.json');}
function writeCheckpoint(state){const dest=checkpointPath(),tmp=dest+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state),'utf8');fs.renameSync(tmp,dest);}
function normalizeDetailUrl(href,base){
 const target=new URL(href,base);
 if(target.protocol!=='https:'||!/(^|\.)a8\.net$/.test(target.hostname))throw Error('A8.net以外の詳細URLは開けません');
 if(!target.pathname.startsWith('/program/detail-'))throw Error('想定外の詳細URLです');
 return target.href;
}
async function getNgWordsByUrl(url){
 const selector='div.pgDetail .pgInnerBottom';
 let last;
 for(let attempt=1;attempt<=3;attempt++){
  try{
   await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
   await page.locator(selector).first().waitFor({state:'visible',timeout:45000});
   await sleep(LIST_DELAY);
   return await page.locator('div.pgDetail .pgInnerBottom tr').evaluateAll(trs=>{
    for(const tr of trs){const th=(tr.querySelector('th')?.textContent||'').replace(/\s/g,'').normalize('NFKC');
     if(th.includes('リスティングNGワード')){
      const el=tr.querySelector('td .preText')||tr.querySelector('td');
      return {found:true,value:(el?.innerText||el?.textContent||'').replace(/\r\n?/g,'\n').trim()};
     }
    }return {found:false,value:''};
   });
  }catch(e){last=e;update(`詳細アクセス ${attempt}/3 回目失敗：${e.message}`);if(attempt<3)await sleep(LIST_DELAY*attempt)}
 }
 throw Error(last?.message||'詳細ページを取得できません');
}
// HTTP mode: use the same Playwright BrowserContext created by manual A8 login.
// No UI page navigation occurs during HTTP data collection.
function apiUrl(pageNo){const u=new URL(SEARCH_API);u.searchParams.set('searchType','KEYWORD');u.searchParams.set('pageNo',String(pageNo));u.searchParams.set('pageSize',String(PAGE_SIZE));u.searchParams.set('sortKey','NORMAL');return u.href;}
function isObject(x){return x!==null&&typeof x==='object'&&!Array.isArray(x);}
function apiListingStatus(v){
 if(v==='PARTIAL_AVAILABLE')return 'PART';
 if(['AVAILABLE','FULL_AVAILABLE'].includes(v))return 'OK';
 if(['UNAVAILABLE','NOT_AVAILABLE','PROHIBITED','NG'].includes(v))return 'NG';
 throw Error('未確認のリスティング区分: '+String(v));
}
function asString(v){return v==null?'':String(v);}
function displayMetric(m,key,suffix=''){
 if(!isObject(m)||m.display_status!=='ENABLED'||m[key]==null)return '';
 return asString(m[key])+suffix;
}
function findResults(obj){
 if(Array.isArray(obj?.program_detail_list))return obj.program_detail_list;
 if(Array.isArray(obj?.data?.program_detail_list))return obj.data.program_detail_list;
 throw Error('一覧APIのprogram_detail_listを検出できません（仕様変更・認証切れの可能性）');
}
function numericTotal(obj){
 const candidates=[obj.total_count,obj.totalCount,obj.total,obj.count,obj.data?.total_count,obj.data?.totalCount,obj.data?.total];
 return candidates.find(x=>Number.isSafeInteger(Number(x))&&Number(x)>0)??null;
}
function detailUrl(id){
 const u=new URL('https://media-console.a8.net/program/detail-not-partnered');
 u.searchParams.set('programId',id);u.searchParams.set('fromSearch','true');return u.href;
}
function fromApi(d){
 if(!isObject(d))throw Error('案件データがオブジェクトではありません');
 const id=asString(d.program_id);if(!/^s\d{10,}$/.test(id))throw Error('案件IDが不正です: '+id);
 if(typeof d.program_name!=='string'||!d.program_name.trim())throw Error(id+': プログラム名がありません');
 const detail=isObject(d.program_detail_text_data)?d.program_detail_text_data:{};
 const icon=isObject(d.icon_attributes)?d.icon_attributes:{};
 const listing=apiListingStatus(icon.listing_status);
 const product=d.create_goods_link_available===true||icon.goods_link_available===true;
 return {id,listing,detailUrl:listing==='PART'?detailUrl(id):'',row:[
 d.program_name,id,asString(detail.achievement_reward),displayMetric(d.last30_days_epc,'epc'),
 displayMetric(d.last3_months_decided_rate,'decided_rate','%'),
 listing==='OK'?'OK':'',listing==='PART'?'OK':'',listing==='NG'?'NG':'',
 asString(d.secondary_category_name),product?'OK':'',''
 ]};
}
async function authenticatedGet(url,{wantJson=false}={}){
 const dest=new URL(url);
 if(dest.protocol!=='https:'||dest.hostname!=='media-console.a8.net')throw Error('A8.net以外へのHTTP取得を拒否しました');
 // maxRetries=0 is deliberately explicit: deal with backoff/429 ourselves.
 const res=await ctx.request.get(dest.href,{timeout:HTTP_TIMEOUT,maxRetries:0,failOnStatusCode:false,headers:{Accept:wantJson?'application/json':'text/html,application/xhtml+xml'}});
 const status=res.status();
 if(status===401||status===403)throw Error('認証またはアクセス権限エラー HTTP '+status+'。ログイン状態を確認してください');
 if(status===429)throw Error('RATE_LIMIT: HTTP 429 (アクセス制限)。取得を停止しました');
 if(status>=500)throw Error('TEMPORARY: HTTP '+status);
 if(status!==200)throw Error('HTTP '+status);
 const body=await res.text();
 if(!body)throw Error('空のレスポンス');
 if(wantJson){
  try{return JSON.parse(body)}catch{throw Error('一覧APIがJSONを返しません（ログイン画面への転送など）')}
 }
 if(/<form[^>]+(?:login|signin)|<title[^>]*>[^<]*(?:ログイン|Login)/i.test(body)&&!body.includes('programDetailModel'))throw Error('ログイン画面が返されました');
 return body;
}
function ngFromHtml(html,expectedId){
 const $=cheerio.load(html,{decodeEntities:true});
 // The original server response contains an HTML-escaped JSON object in this attribute.
 const raw=$('[programdetailmodel]').first().attr('programdetailmodel');
 if(!raw)throw Error('programDetailModel属性がありません（HTML構造変更の可能性）');
 let obj;try{obj=JSON.parse(raw)}catch{throw Error('programDetailModelをJSONとして解析できません')}
 const program=obj?.program_detail;
 if(!program||program.program_id!==expectedId)throw Error('詳細ページの案件IDが一致しません: '+asString(program?.program_id));
 const details=program.program_detail_text_data;
 if(!isObject(details)||!Object.hasOwn(details,'listing_ng_word'))throw Error('NGワードのフィールドがありません');
 return asString(details.listing_ng_word);
}
async function scrape(){
 if(!ctx)throw Error('ログイン済みブラウザがありません');
 const list=[],seen=new Set(),errors=[];
 let pageNo=1,total=null;
 update('STEP 1/2：一覧APIを100件ずつ取得します（ブラウザ画面は切り替わりません）',0,'list');
 while(true){
  const data=await authenticatedGet(apiUrl(pageNo),{wantJson:true});
  const batch=findResults(data);
  if(total===null)total=numericTotal(data);
  if(batch.length>PAGE_SIZE)throw Error('一覧APIから100件を超えるレスポンスが返されました');
  if(!batch.length){if(pageNo===1)throw Error('一覧APIが0件を返しました');break;}
  for(const d of batch){
   const item=fromApi(d);
   if(seen.has(item.id))throw Error('一覧APIで案件IDが重複: '+item.id+' (ページ '+pageNo+')');
   seen.add(item.id);list.push(item);
  }
  update(`STEP 1/2：一覧API ${list.length}${total?'/'+total:''}件（${pageNo}ページ目・最大100件/回）`,total?Math.min(100,100*list.length/total):undefined,'list');
  if(batch.length<PAGE_SIZE)break;
  if(pageNo>=1000)throw Error('一覧取得が1000ページを超えたため停止');
  pageNo++;
  await sleep(LIST_DELAY);
 }
 if(total!==null&&Number(total)!==list.length)throw Error(`一覧APIの総件数が一致しません（${total}件と取得${list.length}件）`);
 const details=list.filter(i=>i.listing==='PART');
 const state={version:2,stage:'details',savedAt:new Date().toISOString(),total:list.length,completedDetails:0,items:list,errors};
 writeCheckpoint(state);
 update(`STEP 1/2完了：${list.length}件。詳細HTML取得対象は${details.length}件`,100,'list');
 update(`STEP 2/2：詳細HTML取得対象 ${details.length}件`,0,'detail');
 for(let i=0;i<details.length;i++){
  const item=details[i];let success=false;
  update(`STEP 2/2：詳細HTML ${i+1}/${details.length}件（${item.id}）`,100*i/Math.max(1,details.length),'detail');
  for(let attempt=1;attempt<=3;attempt++){
   try{
    const html=await authenticatedGet(item.detailUrl);
    item.row[10]=ngFromHtml(html,item.id);
    success=true;break;
   }catch(e){
    if(/RATE_LIMIT|認証またはアクセス権限/.test(e.message)){
     writeCheckpoint(state);throw Error(`${item.id}: ${e.message}`);
    }
    if(attempt===3){errors.push(`${item.id}: 詳細HTML取得失敗: ${e.message}`);update(`詳細取得失敗 ${item.id}: ${e.message}`)}
    else{update(`詳細再試行 ${item.id} (${attempt}/3): ${e.message}`);await sleep(LIST_DELAY*attempt)}
   }
  }
  state.completedDetails=i+1;
  writeCheckpoint(state);
  if((i+1)%10===0||i===details.length-1)update(`STEP 2/2：${i+1}/${details.length}件（失敗 ${errors.length}件）`,100*(i+1)/Math.max(1,details.length),'detail');
  if(i<details.length-1)await sleep(DETAIL_DELAY);
 }
 update(`STEP 2/2完了：${details.length}/${details.length}件`,100,'detail');
 state.stage='finished';writeCheckpoint(state);
 return {records:list.map(x=>x.row),errors,pages:pageNo,details:details.length};
}
function quoteCsv(v){let s=String(v??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
function csv(){return '\uFEFF'+[HEADERS,...rows].map(row=>row.map(quoteCsv).join(',')).join('\r\n')+'\r\n'}
function makeWindow(){win=new BrowserWindow({width:800,height:680,minWidth:710,minHeight:600,title:'ADS-REACH-A8',webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:false}});win.removeMenu();win.loadFile(path.join(__dirname,'index.html'));}
app.whenReady().then(makeWindow);
app.on('window-all-closed',()=>{app.quit()});
app.on('before-quit',()=>{void closeBrowser()});
ipcMain.handle('open-a8',async()=>{if(running)return {ok:false,message:'取得処理中です'};try{await launch();await page.goto('https://www.a8.net/',{waitUntil:'domcontentloaded',timeout:60000});await page.bringToFront();update('A8.netが開きました。手動ログインしてください。');return {ok:true}}catch(e){return {ok:false,message:e.message}}});
ipcMain.handle('run-all',async()=>{
 if(running)return {ok:false,message:'取得処理中です'};
 if(!page||page.isClosed())return {ok:false,message:'先にA8.netを開いてログインしてください'};
 running=true;rows=[];let finished=false;
 try{
  const r=await scrape();if(!r.records.length)throw Error('取得できた案件がありません');
  rows=r.records;finished=true;
  const warning=await logoutAndClose();
  update(`${rows.length}件取得完了（${r.pages}ページ）。CSVを保存できます。${warning?' ※'+warning:''}`);
  return {ok:true,count:rows.length,pages:r.pages,warnings:[...r.errors,...(warning?[warning]:[])]};
 }catch(e){update('取得エラー: '+e.message);return {ok:false,message:e.message}}
 finally{running=false;}
});
ipcMain.handle('save-csv',async()=>{if(running)return {ok:false,message:'処理中です'};if(!rows.length)return {ok:false,message:'全件取得が完了してから保存できます'};
 const d=new Date();const prefix=`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}data_a8.csv`;
 const r=await dialog.showSaveDialog(win,{title:'CSVを保存',defaultPath:path.join(app.getPath('downloads'),prefix),filters:[{name:'CSV',extensions:['csv']}]});if(r.canceled||!r.filePath)return {ok:true,canceled:true};
 try{fs.writeFileSync(r.filePath,csv(),'utf8');return {ok:true,path:r.filePath}}catch(e){return {ok:false,message:e.message}}});

