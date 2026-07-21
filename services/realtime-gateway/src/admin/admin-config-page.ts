export const ADMIN_CONFIG_PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Aipany 服务配置</title>
<style>
:root{font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}.wrap{max-width:1180px;margin:0 auto;padding:32px 20px 64px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:24px}.hero h1{margin:0 0 8px;font-size:30px}.hero p{margin:0;color:#667085}.card{background:#fff;border:1px solid #e4e7ec;border-radius:16px;padding:22px;margin-bottom:18px;box-shadow:0 8px 28px rgba(16,24,40,.05)}.subcard{border:1px solid #d0d5dd;border-radius:14px;padding:18px;margin-top:14px;background:#fcfcfd}.model-card{border:1px solid #eaecf0;border-radius:12px;padding:14px;margin-top:10px;background:#fff}.row-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.row-head h3,.row-head h4{margin:0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.field{display:flex;flex-direction:column;gap:7px}.field.full{grid-column:1/-1}label{font-weight:650;font-size:14px}input,select{width:100%;border:1px solid #d0d5dd;border-radius:10px;padding:11px 12px;font-size:14px;background:#fff}input:focus,select:focus{outline:2px solid #98a2ff;border-color:#6172f3}.hint{font-size:12px;color:#667085}.actions{display:flex;gap:10px;flex-wrap:wrap}.btn{border:0;border-radius:10px;padding:10px 16px;font-weight:700;cursor:pointer}.btn.small{padding:7px 11px;font-size:12px}.primary{background:#3448d8;color:#fff}.secondary{background:#eef2ff;color:#3448d8}.danger{background:#fff1f0;color:#b42318}.ghost{background:#f2f4f7;color:#344054}.status{padding:10px 12px;border-radius:10px;background:#f2f4f7;color:#475467;font-size:14px;white-space:pre-wrap}.ok{background:#ecfdf3;color:#027a48}.bad{background:#fef3f2;color:#b42318}.badge{display:inline-block;padding:3px 8px;border-radius:999px;font-size:12px;background:#eef2ff;color:#3448d8;margin-left:8px}.badge.good{background:#ecfdf3;color:#027a48}.login{max-width:520px;margin:80px auto}.hidden{display:none!important}.toggleline{display:flex;align-items:center;gap:8px;font-size:13px;color:#475467}.toggleline input{width:auto}.empty{padding:24px;text-align:center;border:1px dashed #d0d5dd;border-radius:12px;color:#667085}.test-result{font-size:12px;margin-top:8px;white-space:pre-wrap}.section-note{padding:12px 14px;border-radius:10px;background:#f8f9fc;color:#475467;font-size:13px;margin-bottom:14px}@media(max-width:900px){.grid4{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){.grid,.grid4{grid-template-columns:1fr}.hero{display:block}.wrap{padding-top:20px}}
</style>
</head>
<body>
<div class="wrap">
  <section id="login" class="card login">
    <h1>Aipany 服务配置</h1>
    <p>输入服务器管理 Token 后进入。Token 仅保存在当前浏览器会话中。</p>
    <div class="field"><label>管理 Token</label><input id="adminToken" type="password" autocomplete="current-password" /></div>
    <div class="actions" style="margin-top:16px"><button class="btn primary" id="loginBtn">进入配置</button></div>
    <div id="loginStatus" class="status" style="margin-top:14px">等待登录</div>
  </section>

  <main id="app" class="hidden">
    <div class="hero"><div><h1>Aipany 服务配置</h1><p>运行时 API 配置保存在服务器数据卷，新建会话自动使用最新配置。</p></div><button class="btn secondary" id="logoutBtn">退出</button></div>

    <section class="card">
      <h2>阿里云 DashScope</h2>
      <div class="grid">
        <div class="field full"><label>DASHSCOPE API Key <span id="dashscopeState" class="badge">未配置</span></label><input id="DASHSCOPE_API_KEY" type="password" placeholder="留空表示保留已保存的 Key" /></div>
        <div class="field"><label>Workspace ID</label><input id="DASHSCOPE_WORKSPACE_ID" /></div>
        <div class="field"><label>Qwen ASR Model</label><input id="QWEN_ASR_MODEL" /></div>
        <div class="field full"><label>ASR WebSocket Base URL</label><input id="DASHSCOPE_ASR_WS_BASE_URL" placeholder="留空使用默认地址" /></div>
        <div class="field full"><label>TTS WebSocket Base URL</label><input id="DASHSCOPE_TTS_WS_BASE_URL" placeholder="留空使用默认地址" /></div>
        <div class="field"><label>Qwen TTS Model</label><input id="QWEN_TTS_MODEL" /></div>
        <div class="field"><label>Qwen TTS Voice</label><input id="QWEN_TTS_VOICE" /></div>
        <div class="field"><label>Qwen TTS Language</label><input id="QWEN_TTS_LANGUAGE" /></div>
      </div>
    </section>

    <section class="card">
      <h2>Qwen Omni Cloud Audio</h2>
      <div class="grid">
        <div class="field full"><label>Omni API Key <span id="omniState" class="badge">未配置</span></label><input id="QWEN_OMNI_API_KEY" type="password" placeholder="可留空复用 DASHSCOPE_API_KEY；已保存时留空不修改" /></div>
        <div class="field full"><label>Omni Base URL</label><input id="QWEN_OMNI_BASE_URL" placeholder="留空使用默认 compatible-mode 地址" /></div>
        <div class="field"><label>Omni Model</label><input id="QWEN_OMNI_MODEL" /></div>
        <div class="field"><label>Cloud Audio Intelligence</label><select id="CLOUD_AUDIO_INTELLIGENCE_ENABLED"><option value="true">开启</option><option value="false">关闭</option></select></div>
        <div class="field"><label>Environment Intelligence</label><select id="CLOUD_AUDIO_ENVIRONMENT_ENABLED"><option value="true">开启</option><option value="false">关闭</option></select></div>
        <div class="field"><label>Diarized Transcription</label><select id="CLOUD_AUDIO_DIARIZED_TRANSCRIPTION_ENABLED"><option value="true">开启</option><option value="false">关闭</option></select></div>
      </div>
    </section>

    <section class="card">
      <div class="row-head"><div><h2 style="margin:0">文本 LLM Provider Pool</h2><div class="hint">按优先级尝试“中转站 → 模型 → 请求协议”。首 Token 超时、HTTP 错误或无有效流式文本时自动轮换。</div></div><button class="btn secondary" id="addProviderBtn">添加中转站</button></div>
      <div class="section-note">优先级数字越小越先尝试。某条路由成功后会短期优先复用；失败路由进入冷却。已开始输出文本后若中途失败，为避免重复回答，不会切换到另一模型重新生成。</div>
      <div class="grid4">
        <div class="field"><label>默认首 Token 超时(ms)</label><input id="LLM_POOL_FIRST_TOKEN_TIMEOUT_MS" type="number" min="1000" max="120000" /></div>
        <div class="field"><label>默认总超时(ms)</label><input id="LLM_POOL_TOTAL_TIMEOUT_MS" type="number" min="3000" max="300000" /></div>
        <div class="field"><label>失败冷却(ms)</label><input id="LLM_POOL_COOLDOWN_MS" type="number" min="1000" max="600000" /></div>
        <div class="field"><label>单次最大尝试路由数</label><input id="LLM_POOL_MAX_ATTEMPTS" type="number" min="1" max="100" /></div>
      </div>
      <div id="llmProviders"></div>
    </section>

    <section class="card">
      <h2>Remote GPU / SepFormer</h2>
      <div class="grid">
        <div class="field"><label>Remote Separation</label><select id="REMOTE_SEPARATION_ENABLED"><option value="false">关闭</option><option value="true">开启</option></select></div>
        <div class="field"><label>触发策略</label><select id="REMOTE_SEPARATION_TRIGGER"><option value="overlap_or_multi_speaker">重叠或多人</option><option value="overlap_only">仅重叠</option><option value="always_owner_focus">Owner Focus 总是调用</option></select></div>
        <div class="field full"><label>Remote Base URL</label><input id="REMOTE_SEPARATION_BASE_URL" /></div>
        <div class="field full"><label>Remote Token <span id="remoteState" class="badge">未配置</span></label><input id="REMOTE_SEPARATION_TOKEN" type="password" placeholder="留空表示保留已保存的 Token" /></div>
        <div class="field"><label>Timeout (ms)</label><input id="REMOTE_SEPARATION_TIMEOUT_MS" type="number" min="1000" max="120000" /></div>
      </div>
    </section>

    <section class="card">
      <div class="actions"><button class="btn primary" id="saveBtn">保存配置</button><button class="btn secondary" id="reloadBtn">重新读取</button></div>
      <div id="status" class="status" style="margin-top:14px">尚未保存</div>
      <p class="hint">安全说明：管理 Token 由服务器 .env 提供；所有 API Key 读取时只返回“是否已配置”，不会返回密钥明文。密码框留空代表保留原值。</p>
    </section>
  </main>
</div>
<script>
const secretKeys=["DASHSCOPE_API_KEY","QWEN_OMNI_API_KEY","REMOTE_SEPARATION_TOKEN"];
const fields=["DASHSCOPE_WORKSPACE_ID","DASHSCOPE_ASR_WS_BASE_URL","DASHSCOPE_TTS_WS_BASE_URL","QWEN_ASR_MODEL","QWEN_TTS_MODEL","QWEN_TTS_VOICE","QWEN_TTS_LANGUAGE","QWEN_OMNI_BASE_URL","QWEN_OMNI_MODEL","CLOUD_AUDIO_INTELLIGENCE_ENABLED","CLOUD_AUDIO_ENVIRONMENT_ENABLED","CLOUD_AUDIO_DIARIZED_TRANSCRIPTION_ENABLED","REMOTE_SEPARATION_ENABLED","REMOTE_SEPARATION_BASE_URL","REMOTE_SEPARATION_TIMEOUT_MS","REMOTE_SEPARATION_TRIGGER"];
let token=sessionStorage.getItem("aipanyAdminToken")||"";
let llmPool=defaultPool();
const $=id=>document.getElementById(id);
function auth(){return {Authorization:"Bearer "+token,"Content-Type":"application/json"}}
function setStatus(text,ok){const el=$("status");el.textContent=text;el.className="status "+(ok===true?"ok":ok===false?"bad":"")}
function defaultPool(){return {providers:[],firstTokenTimeoutMs:12000,totalTimeoutMs:60000,cooldownMs:60000,maxAttempts:8}}
function defaultValue(key){const defaults={QWEN_ASR_MODEL:"qwen3-asr-flash-realtime",QWEN_TTS_MODEL:"qwen3-tts-instruct-flash-realtime",QWEN_TTS_VOICE:"Cherry",QWEN_TTS_LANGUAGE:"Chinese",QWEN_OMNI_MODEL:"qwen3.5-omni-flash",CLOUD_AUDIO_INTELLIGENCE_ENABLED:"true",CLOUD_AUDIO_ENVIRONMENT_ENABLED:"true",CLOUD_AUDIO_DIARIZED_TRANSCRIPTION_ENABLED:"true",REMOTE_SEPARATION_ENABLED:"false",REMOTE_SEPARATION_TIMEOUT_MS:"30000",REMOTE_SEPARATION_TRIGGER:"overlap_or_multi_speaker"};return defaults[key]||""}
function uid(prefix){if(window.crypto&&crypto.randomUUID)return prefix+"-"+crypto.randomUUID();return prefix+"-"+Date.now()+"-"+Math.random().toString(16).slice(2)}
function num(value,fallback){const n=Number(value);return Number.isFinite(n)?Math.round(n):fallback}
function create(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node}
function makeInput(type,value,placeholder){const input=create("input");input.type=type||"text";input.value=value===undefined||value===null?"":String(value);if(placeholder)input.placeholder=placeholder;return input}
function makeSelect(options,value){const select=create("select");for(const item of options){const option=create("option");option.value=item[0];option.textContent=item[1];select.appendChild(option)}select.value=String(value);return select}
function addField(parent,labelText,control,full,hint){const box=create("div","field"+(full?" full":""));box.appendChild(create("label",null,labelText));box.appendChild(control);if(hint)box.appendChild(create("div","hint",hint));parent.appendChild(box);return box}
function normalizePool(pool){const source=pool&&typeof pool==="object"?pool:defaultPool();return {providers:Array.isArray(source.providers)?source.providers.map(p=>({id:p.id||uid("provider"),name:p.name||"新中转站",baseUrl:p.baseUrl||"",apiKey:"",apiKeyConfigured:Boolean(p.apiKeyConfigured),enabled:p.enabled!==false,priority:num(p.priority,100),firstTokenTimeoutMs:p.firstTokenTimeoutMs===undefined?undefined:num(p.firstTokenTimeoutMs,12000),totalTimeoutMs:p.totalTimeoutMs===undefined?undefined:num(p.totalTimeoutMs,60000),models:Array.isArray(p.models)?p.models.map(m=>({id:m.id||"",label:m.label||"",enabled:m.enabled!==false,priority:num(m.priority,100),protocols:Array.isArray(m.protocols)&&m.protocols.length?m.protocols:["chat_completions"]})):[]})):[],firstTokenTimeoutMs:num(source.firstTokenTimeoutMs,12000),totalTimeoutMs:num(source.totalTimeoutMs,60000),cooldownMs:num(source.cooldownMs,60000),maxAttempts:num(source.maxAttempts,8)}}
function renderLlmPool(){
 const container=$("llmProviders");container.innerHTML="";
 $("LLM_POOL_FIRST_TOKEN_TIMEOUT_MS").value=String(llmPool.firstTokenTimeoutMs);
 $("LLM_POOL_TOTAL_TIMEOUT_MS").value=String(llmPool.totalTimeoutMs);
 $("LLM_POOL_COOLDOWN_MS").value=String(llmPool.cooldownMs);
 $("LLM_POOL_MAX_ATTEMPTS").value=String(llmPool.maxAttempts);
 if(!llmPool.providers.length){container.appendChild(create("div","empty","尚未配置 LLM 中转站。点击“添加中转站”开始配置。"));return}
 llmPool.providers.forEach((provider,providerIndex)=>container.appendChild(renderProvider(provider,providerIndex)));
}
function renderProvider(provider,providerIndex){
 const card=create("div","subcard");
 const head=create("div","row-head");
 const title=create("div");title.appendChild(create("h3",null,(providerIndex+1)+". "+(provider.name||"未命名中转站")));
 const secret=create("span","badge "+(provider.apiKeyConfigured?"good":""),provider.apiKeyConfigured?"Key 已保存":"Key 未保存");title.appendChild(secret);head.appendChild(title);
 const headActions=create("div","actions");const addModel=create("button","btn small secondary","添加模型");addModel.type="button";addModel.onclick=()=>{provider.models.push({id:"",label:"",enabled:true,priority:100,protocols:["chat_completions"]});renderLlmPool()};headActions.appendChild(addModel);
 const remove=create("button","btn small danger","删除中转站");remove.type="button";remove.onclick=()=>{if(confirm("确定删除这个中转站吗？")){llmPool.providers.splice(providerIndex,1);renderLlmPool()}};headActions.appendChild(remove);head.appendChild(headActions);card.appendChild(head);
 const grid=create("div","grid");
 const name=makeInput("text",provider.name);name.oninput=()=>{provider.name=name.value};addField(grid,"名称",name,false);
 const enabled=makeSelect([["true","启用"],["false","停用"]],provider.enabled?"true":"false");enabled.onchange=()=>{provider.enabled=enabled.value==="true"};addField(grid,"状态",enabled,false);
 const url=makeInput("url",provider.baseUrl,"https://example.com/v1");url.oninput=()=>{provider.baseUrl=url.value};addField(grid,"Base URL",url,true);
 const key=makeInput("password","",provider.apiKeyConfigured?"留空保留已保存的 Key":"请输入 API Key");key.oninput=()=>{provider.apiKey=key.value};addField(grid,"API Key",key,true,"读取配置时不会回传密钥明文；Provider ID 不变时留空会保留原 Key。");
 const priority=makeInput("number",provider.priority);priority.min="0";priority.max="10000";priority.oninput=()=>{provider.priority=num(priority.value,100)};addField(grid,"中转站优先级",priority,false,"数字越小越优先");
 const first=makeInput("number",provider.firstTokenTimeoutMs===undefined?"":provider.firstTokenTimeoutMs,"留空继承全局");first.min="1000";first.max="120000";first.oninput=()=>{provider.firstTokenTimeoutMs=first.value?num(first.value,llmPool.firstTokenTimeoutMs):undefined};addField(grid,"首 Token 超时(ms)",first,false);
 const total=makeInput("number",provider.totalTimeoutMs===undefined?"":provider.totalTimeoutMs,"留空继承全局");total.min="3000";total.max="300000";total.oninput=()=>{provider.totalTimeoutMs=total.value?num(total.value,llmPool.totalTimeoutMs):undefined};addField(grid,"总超时(ms)",total,false);
 card.appendChild(grid);
 const models=create("div");if(!provider.models.length)models.appendChild(create("div","empty","该中转站还没有模型。"));provider.models.forEach((model,modelIndex)=>models.appendChild(renderModel(provider,model,modelIndex)));card.appendChild(models);return card;
}
function renderModel(provider,model,modelIndex){
 const card=create("div","model-card");const head=create("div","row-head");head.appendChild(create("h4",null,"模型 "+(modelIndex+1)+(model.id?" · "+model.id:"")));
 const remove=create("button","btn small danger","删除模型");remove.type="button";remove.onclick=()=>{provider.models.splice(modelIndex,1);renderLlmPool()};head.appendChild(remove);card.appendChild(head);
 const grid=create("div","grid4");
 const id=makeInput("text",model.id,"例如 gpt-5.6-sol");id.oninput=()=>{model.id=id.value};addField(grid,"模型 ID",id,false);
 const enabled=makeSelect([["true","启用"],["false","停用"]],model.enabled?"true":"false");enabled.onchange=()=>{model.enabled=enabled.value==="true"};addField(grid,"状态",enabled,false);
 const priority=makeInput("number",model.priority);priority.min="0";priority.max="10000";priority.oninput=()=>{model.priority=num(priority.value,100)};addField(grid,"模型优先级",priority,false);
 const primary=makeSelect([["chat_completions","Chat Completions"],["responses","Responses API"]],model.protocols[0]||"chat_completions");primary.onchange=()=>{const other=primary.value==="chat_completions"?"responses":"chat_completions";model.protocols=model.protocols.length>1?[primary.value,other]:[primary.value];renderLlmPool()};addField(grid,"首选请求方式",primary,false);
 card.appendChild(grid);
 const line=create("div","toggleline");const fallback=makeInput("checkbox");fallback.checked=model.protocols.length>1;fallback.onchange=()=>{const other=model.protocols[0]==="chat_completions"?"responses":"chat_completions";model.protocols=fallback.checked?[model.protocols[0],other]:[model.protocols[0]];renderLlmPool()};line.appendChild(fallback);line.appendChild(create("span",null,"同模型启用另一种请求方式作为备用路由"));card.appendChild(line);
 const actions=create("div","actions");actions.style.marginTop="10px";for(const protocol of model.protocols){const button=create("button","btn small ghost","测试 "+(protocol==="chat_completions"?"Chat":"Responses"));button.type="button";button.onclick=()=>testLlm(provider.id,model.id,protocol);actions.appendChild(button)}card.appendChild(actions);
 const result=create("div","test-result");result.id="test-"+provider.id+"-"+model.id.replace(/[^a-zA-Z0-9_-]/g,"_");card.appendChild(result);return card;
}
function collectPool(){
 llmPool.firstTokenTimeoutMs=num($("LLM_POOL_FIRST_TOKEN_TIMEOUT_MS").value,12000);
 llmPool.totalTimeoutMs=num($("LLM_POOL_TOTAL_TIMEOUT_MS").value,60000);
 llmPool.cooldownMs=num($("LLM_POOL_COOLDOWN_MS").value,60000);
 llmPool.maxAttempts=num($("LLM_POOL_MAX_ATTEMPTS").value,8);
 return {providers:llmPool.providers.map(p=>{const out={id:p.id,name:(p.name||"").trim(),baseUrl:(p.baseUrl||"").trim(),apiKey:(p.apiKey||"").trim(),enabled:Boolean(p.enabled),priority:num(p.priority,100),models:p.models.map(m=>({id:(m.id||"").trim(),label:(m.label||"").trim()||undefined,enabled:Boolean(m.enabled),priority:num(m.priority,100),protocols:m.protocols.slice()}))};if(p.firstTokenTimeoutMs!==undefined)out.firstTokenTimeoutMs=num(p.firstTokenTimeoutMs,12000);if(p.totalTimeoutMs!==undefined)out.totalTimeoutMs=num(p.totalTimeoutMs,60000);return out}),firstTokenTimeoutMs:llmPool.firstTokenTimeoutMs,totalTimeoutMs:llmPool.totalTimeoutMs,cooldownMs:llmPool.cooldownMs,maxAttempts:llmPool.maxAttempts}
}
async function loadConfig(){
 const r=await fetch("/admin/api/config",{headers:auth()});if(!r.ok)throw new Error(await r.text());const data=await r.json();
 for(const key of fields){const el=$(key);if(el)el.value=data.values[key]||defaultValue(key)}
 $("dashscopeState").textContent=data.secrets.DASHSCOPE_API_KEY&&data.secrets.DASHSCOPE_API_KEY.configured?"已配置":"未配置";
 $("omniState").textContent=data.secrets.QWEN_OMNI_API_KEY&&data.secrets.QWEN_OMNI_API_KEY.configured?"已配置/或复用":"未单独配置";
 $("remoteState").textContent=data.secrets.REMOTE_SEPARATION_TOKEN&&data.secrets.REMOTE_SEPARATION_TOKEN.configured?"已配置":"未配置";
 llmPool=normalizePool(data.llmProviderPool);renderLlmPool();setStatus("配置已读取。保存路径："+data.path,true);return data;
}
async function login(){token=$("adminToken").value.trim();if(!token)return;sessionStorage.setItem("aipanyAdminToken",token);try{await loadConfig();$("login").classList.add("hidden");$("app").classList.remove("hidden")}catch(e){$("loginStatus").textContent="登录失败："+e.message;sessionStorage.removeItem("aipanyAdminToken")}}
async function save(silent){
 const body={llmProviderPool:collectPool()};for(const key of fields)body[key]=$(key).value.trim();for(const key of secretKeys){const value=$(key).value.trim();if(value)body[key]=value}
 if(!silent)setStatus("正在保存…");const r=await fetch("/admin/api/config",{method:"PUT",headers:auth(),body:JSON.stringify(body)});if(!r.ok){const message=await r.text();if(!silent)setStatus("保存失败："+message,false);throw new Error(message)}for(const key of secretKeys)$(key).value="";await loadConfig();if(!silent)setStatus("保存成功。新建立的实时会话会立即使用最新 Provider Pool。",true)
}
async function testLlm(providerId,modelId,protocol){
 try{setStatus("正在保存当前配置并测试 "+modelId+" / "+protocol+" …");await save(true);const started=Date.now();const r=await fetch("/admin/api/config/llm-test",{method:"POST",headers:auth(),body:JSON.stringify({providerId:providerId,modelId:modelId,protocol:protocol})});const data=await r.json();if(!r.ok)throw new Error(data.message||JSON.stringify(data));setStatus("测试成功："+modelId+" / "+protocol+"，耗时 "+data.elapsedMs+"ms，返回："+data.text,true)}catch(e){setStatus("LLM 路由测试失败："+e.message,false)}
}
$("addProviderBtn").onclick=()=>{llmPool.providers.push({id:uid("provider"),name:"新中转站",baseUrl:"",apiKey:"",apiKeyConfigured:false,enabled:false,priority:(llmPool.providers.length+1)*100,models:[]});renderLlmPool()};
$("loginBtn").onclick=login;$("adminToken").addEventListener("keydown",e=>{if(e.key==="Enter")login()});$("saveBtn").onclick=()=>save(false).catch(()=>{});$("reloadBtn").onclick=()=>loadConfig().catch(e=>setStatus(e.message,false));$("logoutBtn").onclick=()=>{sessionStorage.removeItem("aipanyAdminToken");location.reload()};if(token){loadConfig().then(()=>{$("login").classList.add("hidden");$("app").classList.remove("hidden")}).catch(()=>sessionStorage.removeItem("aipanyAdminToken"))}
</script>
</body></html>`;
