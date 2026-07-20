export const ADMIN_CONFIG_PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Aipany 服务配置</title>
<style>
:root{font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}.wrap{max-width:1080px;margin:0 auto;padding:32px 20px 64px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:24px}.hero h1{margin:0 0 8px;font-size:30px}.hero p{margin:0;color:#667085}.card{background:#fff;border:1px solid #e4e7ec;border-radius:16px;padding:22px;margin-bottom:18px;box-shadow:0 8px 28px rgba(16,24,40,.05)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.field{display:flex;flex-direction:column;gap:7px}.field.full{grid-column:1/-1}label{font-weight:650;font-size:14px}input,select{width:100%;border:1px solid #d0d5dd;border-radius:10px;padding:11px 12px;font-size:14px;background:#fff}input:focus,select:focus{outline:2px solid #98a2ff;border-color:#6172f3}.hint{font-size:12px;color:#667085}.actions{display:flex;gap:12px;flex-wrap:wrap}.btn{border:0;border-radius:10px;padding:11px 18px;font-weight:700;cursor:pointer}.primary{background:#3448d8;color:#fff}.secondary{background:#eef2ff;color:#3448d8}.danger{background:#fff1f0;color:#b42318}.status{padding:10px 12px;border-radius:10px;background:#f2f4f7;color:#475467;font-size:14px;white-space:pre-wrap}.ok{background:#ecfdf3;color:#027a48}.bad{background:#fef3f2;color:#b42318}.badge{display:inline-block;padding:3px 8px;border-radius:999px;font-size:12px;background:#eef2ff;color:#3448d8;margin-left:8px}.login{max-width:520px;margin:80px auto}.hidden{display:none!important}@media(max-width:760px){.grid{grid-template-columns:1fr}.hero{display:block}.wrap{padding-top:20px}}
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
      <h2>文本 LLM</h2>
      <div class="grid">
        <div class="field full"><label>LLM API Key <span id="llmState" class="badge">未配置</span></label><input id="LLM_API_KEY" type="password" placeholder="留空表示保留已保存的 Key" /></div>
        <div class="field full"><label>LLM Base URL</label><input id="LLM_BASE_URL" /></div>
        <div class="field"><label>LLM Model</label><input id="LLM_MODEL" /></div>
      </div>
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
      <p class="hint">安全说明：管理 Token 由服务器 .env 提供；API 密钥不会从读取接口返回到浏览器。密码框留空代表保留原值。</p>
    </section>
  </main>
</div>
<script>
const secretKeys=["DASHSCOPE_API_KEY","QWEN_OMNI_API_KEY","LLM_API_KEY","REMOTE_SEPARATION_TOKEN"];
const fields=["DASHSCOPE_WORKSPACE_ID","DASHSCOPE_ASR_WS_BASE_URL","DASHSCOPE_TTS_WS_BASE_URL","QWEN_ASR_MODEL","QWEN_TTS_MODEL","QWEN_TTS_VOICE","QWEN_TTS_LANGUAGE","QWEN_OMNI_BASE_URL","QWEN_OMNI_MODEL","LLM_BASE_URL","LLM_MODEL","CLOUD_AUDIO_INTELLIGENCE_ENABLED","CLOUD_AUDIO_ENVIRONMENT_ENABLED","CLOUD_AUDIO_DIARIZED_TRANSCRIPTION_ENABLED","REMOTE_SEPARATION_ENABLED","REMOTE_SEPARATION_BASE_URL","REMOTE_SEPARATION_TIMEOUT_MS","REMOTE_SEPARATION_TRIGGER"];
let token=sessionStorage.getItem("aipanyAdminToken")||"";
const $=id=>document.getElementById(id);
function auth(){return {Authorization:"Bearer "+token,"Content-Type":"application/json"}}
function setStatus(text,ok){const el=$("status");el.textContent=text;el.className="status "+(ok===true?"ok":ok===false?"bad":"")}
async function loadConfig(){
 const r=await fetch("/admin/api/config",{headers:auth()});
 if(!r.ok)throw new Error(await r.text());
 const data=await r.json();
 for(const key of fields){const el=$(key);if(el)el.value=data.values[key]||defaultValue(key)}
 $("dashscopeState").textContent=data.secrets.DASHSCOPE_API_KEY?.configured?"已配置":"未配置";
 $("omniState").textContent=data.secrets.QWEN_OMNI_API_KEY?.configured?"已配置/或复用":"未单独配置";
 $("llmState").textContent=data.secrets.LLM_API_KEY?.configured?"已配置":"未配置";
 $("remoteState").textContent=data.secrets.REMOTE_SEPARATION_TOKEN?.configured?"已配置":"未配置";
 setStatus("配置已读取。保存路径："+data.path,true);
}
function defaultValue(key){const defaults={QWEN_ASR_MODEL:"qwen3-asr-flash-realtime",QWEN_TTS_MODEL:"qwen3-tts-instruct-flash-realtime",QWEN_TTS_VOICE:"Cherry",QWEN_TTS_LANGUAGE:"Chinese",QWEN_OMNI_MODEL:"qwen3.5-omni-flash",LLM_BASE_URL:"https://api.openai.com/v1",LLM_MODEL:"gpt-5.6-sol",CLOUD_AUDIO_INTELLIGENCE_ENABLED:"true",CLOUD_AUDIO_ENVIRONMENT_ENABLED:"true",CLOUD_AUDIO_DIARIZED_TRANSCRIPTION_ENABLED:"true",REMOTE_SEPARATION_ENABLED:"false",REMOTE_SEPARATION_TIMEOUT_MS:"30000",REMOTE_SEPARATION_TRIGGER:"overlap_or_multi_speaker"};return defaults[key]||""}
async function login(){token=$("adminToken").value.trim();if(!token)return;sessionStorage.setItem("aipanyAdminToken",token);try{await loadConfig();$("login").classList.add("hidden");$("app").classList.remove("hidden")}catch(e){$("loginStatus").textContent="登录失败："+e.message;sessionStorage.removeItem("aipanyAdminToken")}}
async function save(){const body={};for(const key of fields)body[key]=$(key).value.trim();for(const key of secretKeys){const value=$(key).value.trim();if(value)body[key]=value}
 setStatus("正在保存…");const r=await fetch("/admin/api/config",{method:"PUT",headers:auth(),body:JSON.stringify(body)});if(!r.ok){setStatus("保存失败："+await r.text(),false);return}for(const key of secretKeys)$(key).value="";await loadConfig();setStatus("保存成功。新建立的实时会话会立即使用最新配置。",true)}
$("loginBtn").onclick=login;$("adminToken").addEventListener("keydown",e=>{if(e.key==="Enter")login()});$("saveBtn").onclick=save;$("reloadBtn").onclick=()=>loadConfig().catch(e=>setStatus(e.message,false));$("logoutBtn").onclick=()=>{sessionStorage.removeItem("aipanyAdminToken");location.reload()};if(token){loadConfig().then(()=>{$("login").classList.add("hidden");$("app").classList.remove("hidden")}).catch(()=>sessionStorage.removeItem("aipanyAdminToken"))}
</script>
</body></html>`;
