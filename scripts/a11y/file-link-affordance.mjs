// ============================================================================
// scripts/a11y/file-link-affordance.mjs — W2052：正文路径「看起来可点」的真机审计
// ----------------------------------------------------------------------------
// 缺陷（用户报障「链接点击和文件路径点击怎么还没做」）：能力已交付（W2013 点击
// 委托 + W2025 键盘通道），但**样式侧一个字节都没有** ⇒ 真机实测 data-fl-hit 与
// 周围正文逐条相同（color rgb(17,17,17) / text-decoration none / cursor auto）
// ⇒ 用户判定「没做」。
//
// ★ 为什么需要真机而不是只靠 jsdom 门禁：
//   jsdom 30 **不解析 var()**，而且**会整条丢掉含 var() 的 outline 简写**。
//   于是「焦点环真的画出来了吗」「线色在四套配色下真的达标吗」这两件事，
//   jsdom 里只能读 CSS 文本（声明存在），读不到「浏览器实际算出的值」。
//   本脚本补上那半：真 Chrome 的 getComputedStyle + 真截图。
//
// ★ 为什么用「换掉 components.css 再跑一遍」做 A/B 而不是注入覆盖样式：
//   改动前那份 CSS 里**根本没有** [data-fl-hit] 规则，注入任何覆盖都只是
//   「模拟一个我以为的改动前」。直接把 HEAD 版本换进去，量到的才是真·改动前。
//   脚本自己不做 git 写操作：调用方把两份文件准备好，用 W2052_TAG 标注。
//
// 用法：
//   pnpm --dir apps/web dev --port 3787 --strictPort        # 前置（只读 /src/**）
//   W9111_CHROME=<chrome-headless-shell> W2052_TAG=before \
//     node scripts/a11y/file-link-affordance.mjs            # 期望 AFFORDANCE=FAIL
//   W9111_CHROME=<chrome-headless-shell> W2052_TAG=after  \
//     node scripts/a11y/file-link-affordance.mjs            # 期望 AFFORDANCE=PASS
//   两次都要 consoleErrors=0。
//
// ★ **刻意不进门禁**（与 ime-enter-guard.mjs / audit-touch-targets.mjs 同一取向）：
//   它需要 Vite dev server + Chrome，不是确定性离线门禁。确定性断言在
//   apps/web/src/ui/enhance/file-link-visual.test.ts（jsdom，进门禁）。
// ============================================================================
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchChrome } from '../perf/lib/chrome.mjs';
import { startBackend } from '../perf/lib/backend.mjs';

/** 只在静态根是 apps/web（源码形态）时才需要 Vite；量 dist 时用不到。 */
const VITE = process.env.W2052_VITE ?? 'http://127.0.0.1:3787';
const TAG = process.env.W2052_TAG ?? 'unknown';
/**
 * 静态根。默认 `apps/web`（配 Vite dev server 用，只读 /src/**）；
 * 设 `W2052_WEBROOT=<repo>/apps/web/dist` 则改量**真实产物**（不再需要 dev server）
 * —— 这是「用户实际会下载到的那份 CSS」的验证口径。
 */
const WEB = process.env.W2052_WEBROOT ?? new URL('../../apps/web', import.meta.url).pathname;
const SHOTS = process.env.W2052_SHOTS ?? '/tmp/w2052-affordance';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });

/** 正文夹具：路径**嵌在句子里**（不是列表），这才是「密不密」的真实压力。 */
const BODY = [
  '缺陷在 `apps/web/src/ui/enhance/file-link-mark.ts` 里：它给命中节点写了 role 与 tabindex，',
  '但样式侧一个字节都没有。我复核了 `apps/web/src/styles/components.css` 第 234 行，那里只给',
  'markdown 链接配了 hover 下划线，正文路径连 hover 提示都没有。可用 token 在',
  '`apps/web/src/styles/tokens.css` 里，焦点环 token 是 W2006 加的。',
  '',
  '修法只需要动一个文件：文件：apps/web/src/styles/components.css，',
  '再补一条断言到 文件：apps/web/src/ui/enhance/file-link-visual.test.ts。',
  '回归跑 文件：apps/web/src/ui/enhance/file-link.test.ts 与',
  '文件：apps/web/src/ui/enhance/file-link-keys.test.ts 两个既有用例集。',
].join('\n');
const HISTORY = [{ role: 'assistant', content: BODY }];

const chrome = await launchChrome({ port: 9470, width: 1440, height: 900 });
const backend = await startBackend({ port: 3810, webRoot: WEB, viteOrigin: VITE, history: HISTORY });
const { page } = chrome;
const consoleErrors = [];
page.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') consoleErrors.push((p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' '));
});
page.on('Runtime.exceptionThrown', (p) => {
  consoleErrors.push('EXCEPTION ' + (p.exceptionDetails?.exception?.description ?? ''));
});

async function waitFor(body, label, t = 25000) {
  const dl = Date.now() + t;
  while (Date.now() < dl) { if (await page.eval('(function(){ ' + body + ' })()')) return true; await sleep(120); }
  throw new Error('waitFor timeout: ' + label);
}

/** 页内量一套样式：命中节点（label 形态 + code 形态）、正文、焦点环、对比度。 */
const PROBE = `(function(){
  function parse(c){ var m=String(c).match(/rgba?\\(([^)]+)\\)/); if(!m) return null;
    var p=m[1].split(',').map(parseFloat); return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}; }
  function comp(f,b){ var a=f.a; return {r:f.r*a+b.r*(1-a),g:f.g*a+b.g*(1-a),b:f.b*a+b.b*(1-a),a:1}; }
  function lum(c){ var f=function(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);};
    return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b); }
  function ratio(a,b){ var l1=lum(a),l2=lum(b); if(l1<l2){var t=l1;l1=l2;l2=t;} return (l1+0.05)/(l2+0.05); }
  function effBg(el){ var n=el; while(n){ var c=parse(getComputedStyle(n).backgroundColor); if(c&&c.a>0.99) return c; n=n.parentElement; }
    return {r:255,g:255,b:255,a:1}; }
  function snap(el){ if(!el) return null; var s=getComputedStyle(el); var bg=effBg(el);
    return { color:s.color, textDecorationLine:s.textDecorationLine, textDecorationColor:s.textDecorationColor,
      textDecorationThickness:s.textDecorationThickness, textUnderlineOffset:s.textUnderlineOffset,
      cursor:s.cursor, outline:s.outlineWidth+' '+s.outlineStyle+' '+s.outlineColor, outlineOffset:s.outlineOffset,
      textContrast:Math.round(ratio(comp(parse(s.color),bg),bg)*100)/100,
      decoContrast:Math.round(ratio(comp(parse(s.textDecorationColor),bg),bg)*100)/100 }; }
  // ★ 先 blur：焦点环会把 text-decoration-color 提到 currentColor（这是设计），
  //   若上一次 FOCUS_PROBE 的焦点还留在停靠点上，下面量到的就不是**静止态**。
  //   本探针的契约是「静止态」，所以每次都从零开始（本轮实测踩到：切换主题后
  //   hitCode 的线色变成了 currentColor，读出来像 bug，其实是残留焦点）。
  if(document.activeElement && document.activeElement.blur) document.activeElement.blur();
  var box=document.querySelector('.content.rendered');
  if(!box) return { ok:false, why:'no .content.rendered' };
  var hits=box.querySelectorAll('[data-fl-hit]');
  if(hits.length===0) return { ok:false, why:'no [data-fl-hit]' };
  var stop=box.querySelector('[data-fl-hit][tabindex=\"0\"]');
  var ringColor=null, ringContrast=null;
  if(stop){ var bg=effBg(stop); var tmp=document.createElement('div');
    tmp.style.color=getComputedStyle(document.documentElement).getPropertyValue('--c-focus-ring').trim();
    document.body.appendChild(tmp); var rc=parse(getComputedStyle(tmp).color); tmp.remove();
    if(rc){ ringColor=getComputedStyle(document.documentElement).getPropertyValue('--c-focus-ring').trim();
      ringContrast=Math.round(ratio(comp(rc,bg),bg)*100)/100; } }
  return { ok:true, theme:document.documentElement.dataset.theme,
    hits:hits.length, stops:box.querySelectorAll('[data-fl-hit][tabindex=\"0\"]').length,
    labels:box.querySelectorAll('.file-link-label').length,
    codes:box.querySelectorAll('code[data-fl-hit]').length,
    hit:snap(box.querySelector('.file-link-label')||hits[0]),
    hitCode:snap(box.querySelector('code[data-fl-hit]')),
    prose:snap(box.querySelector('p')), ringColor:ringColor, ringContrast:ringContrast,
    boxH:Math.round(box.getBoundingClientRect().height) };
})()`;

/** 真聚焦唯一停靠点，量浏览器**实际**画出来的焦点环。 */
const FOCUS_PROBE = `(function(){
  var box=document.querySelector('.content.rendered');
  var stop=box.querySelector('[data-fl-hit][tabindex=\"0\"]');
  if(!stop) return { ok:false };
  stop.focus();
  var s=getComputedStyle(stop);
  return { ok:true, focused:document.activeElement===stop, matchesFV:stop.matches(':focus-visible'),
    text:(stop.textContent||'').slice(0,44),
    outlineWidth:s.outlineWidth, outlineStyle:s.outlineStyle, outlineColor:s.outlineColor,
    outlineOffset:s.outlineOffset };
})()`;

const RESULTS = [];
function check(label, ok, detail) {
  RESULTS.push({ label, ok });
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + label + (detail ? '  ' + detail : ''));
}

/** 一次「量 + 判 + 截图」。 */
async function shoot(name, clip) {
  const r = await page.send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
  const p = SHOTS + '/' + TAG + '-' + name + '.png';
  writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

try {
  console.log('########## W2052 真机审计 · 变体=' + TAG + ' ##########');

  for (const [mode, w, h, dsf, mobile, coarse] of [['desktop', 1440, 900, 1, false, 'fine'], ['touch', 390, 844, 2, true, 'coarse']]) {
    await page.navigate(backend.origin + '/');
    await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dsf, mobile });
    // maxTouchPoints 只在开启触摸时给（CDP 要求 1..16，给 0 会 -32602）。
    if (mobile) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: coarse }] });
    await waitFor("return document.querySelector('.content.rendered [data-fl-hit]')!==null;", 'hit');
    console.log('======== ' + mode + ' ' + w + 'x' + h + ' ========');

    for (const [tname, theme, scheme] of [['mono', 'mono', 'light'], ['dark', 'dark', 'dark'], ['claude-light', 'claude', 'light'], ['claude-dark', 'claude', 'dark']]) {
      await page.eval('document.documentElement.dataset.theme=' + JSON.stringify(theme));
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'pointer', value: coarse }] });
      await sleep(150);
      const d = await page.eval(PROBE);
      console.log('  [' + tname + '] ' + JSON.stringify(d));
      if (!d.ok) { check(mode + '/' + tname + ' 夹具就绪', false, d.why); continue; }

      const f = await page.eval(FOCUS_PROBE);
      console.log('  [' + tname + '] focus ' + JSON.stringify(f));

      if (mode === 'desktop' && (tname === 'mono' || tname === 'dark')) {
        console.log('  [shot] ' + await shoot(mode + '-' + tname, { x: 520, y: 95, width: 730, height: 300, scale: 2 }));
      }
      if (mode === 'desktop' && (tname === 'claude-light' || tname === 'claude-dark')) {
        console.log('  [shot] ' + await shoot(mode + '-' + tname, { x: 520, y: 95, width: 730, height: 300, scale: 2 }));
      }
      if (mode === 'desktop' && tname === 'mono') {
        console.log('  [shot full] ' + await shoot(mode + '-mono-full'));
        console.log('  [shot focus] ' + await shoot(mode + '-mono-focus', { x: 520, y: 95, width: 730, height: 160, scale: 2 }));
      }

      // ---- 断言 ----
      const tag = mode + '/' + tname;
      check(tag + ' 静态与正文可分辨', d.hit.textDecorationLine !== d.prose.textDecorationLine || d.hit.color !== d.prose.color || d.hit.cursor !== d.prose.cursor);
      check(tag + ' 下划线静态存在', d.hit.textDecorationLine === 'underline');
      check(tag + ' 线色 != 文字色', d.hit.textDecorationColor !== d.hit.color);
      check(tag + ' cursor=pointer', d.hit.cursor === 'pointer' && d.hitCode !== null && d.hitCode.cursor === 'pointer');
      check(tag + ' 线对比度 >= 3:1', d.hit.decoContrast >= 3, 'deco=' + d.hit.decoContrast + ' text=' + d.hit.textContrast);
      check(tag + ' 线淡于正文', d.hit.decoContrast < d.hit.textContrast);
      check(tag + ' 焦点环对比度 >= 3:1', d.ringContrast !== null && d.ringContrast >= 3, 'ring=' + d.ringContrast + ' (' + d.ringColor + ')');
      check(tag + ' 真聚焦画出焦点环', f.ok === true && f.matchesFV === true && parseFloat(f.outlineWidth) >= 2 && f.outlineStyle === 'solid', JSON.stringify(f.outlineWidth + ' ' + f.outlineStyle + ' ' + f.outlineColor));
      check(tag + ' 一容器一停靠点（W2025 未破）', d.stops === 1, 'hits=' + d.hits + ' stops=' + d.stops);
    }
  }

  // 排版回归：下划线不得改变正文盒高（before/after 各自与自身比是恒等，这里只记录）
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.send('Emulation.setEmulatedMedia', { features: [] });
  const geo = await page.eval("(function(){ var b=document.querySelector('.content.rendered'); return b===null?null:Math.round(b.getBoundingClientRect().height); })()");
  console.log('  [geometry] 正文盒高 boxH=' + geo);
} finally {
  console.log('consoleErrors=' + consoleErrors.length + (consoleErrors.length ? ' ' + JSON.stringify(consoleErrors) : ''));
  const bad = RESULTS.filter((r) => !r.ok);
  console.log('AFFORDANCE=' + (bad.length === 0 ? 'PASS' : 'FAIL') + ' (' + (RESULTS.length - bad.length) + '/' + RESULTS.length + ')');
  if (bad.length > 0) for (const b of bad) console.log('  ✗ ' + b.label);
  await chrome.close();
  await backend.close();
}
