// @ts-check
/**
 * 校验克隆输出横幅 + 富文本日志 iframe：流式刷新时不应在用户向上翻阅时强制滚回顶部/底部错位。
 * 依赖本机服务：BASE_URL=http://127.0.0.1:8765 npx playwright test --project=chromium e2e/job-raw-log-scroll.spec.mjs
 */
import { test, expect } from '@playwright/test';

const TOKEN = process.env.ACCESS_TOKEN || 'dev-local-token';

function tallSrcdoc(lineCount) {
  const lines = Array.from({ length: lineCount }, (_, i) => `LINE_${i}`).join('\n');
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
      'html,body{margin:0;padding:8px;background:#161618;color:#e8e8e8;font:13px/1.45 monospace}' +
      'pre{margin:0;white-space:pre-wrap;word-break:break-word}' +
      '</style></head><body><pre>' +
      lines.replace(/</g, '&lt;') +
      '</pre></body></html>'
  );
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} origin
 */
async function gotoUi(page, origin) {
  await page.goto(`${origin}/ui/${encodeURIComponent(TOKEN)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__onlineServiceUiTest && typeof window.__onlineServiceUiTest.setExecRichIframeSrcdocSticky === 'function',
    null,
    { timeout: 15_000 },
  );
}

test.describe('原始控制台日志 iframe 滚动', () => {
  test('向上翻阅时分片更新不应强制滚到底部；贴底时仍跟随底部', async ({ page, baseURL }) => {
    const origin = baseURL || 'http://127.0.0.1:8765';
    await gotoUi(page, origin);

    const result = await page.evaluate(async ({ tallA, tallB }) => {
      const W = window.__onlineServiceUiTest;
      if (!W || typeof W.setExecRichIframeSrcdocSticky !== 'function') {
        return { ok: false, reason: 'missing __onlineServiceUiTest' };
      }
      const host = document.createElement('div');
      host.innerHTML =
        '<iframe class="out exec-rich-frame job-raw-frame" data-job-id="e2e-scroll"></iframe>';
      document.body.appendChild(host);
      const fr = /** @type {HTMLIFrameElement} */ (host.querySelector('iframe'));
      if (!fr) return { ok: false, reason: 'no iframe' };

      const waitLoad = () =>
        new Promise((resolve) => {
          fr.addEventListener('load', () => resolve(undefined), { once: true });
          setTimeout(resolve, 80);
        });

      W.setExecRichIframeSrcdocSticky(fr, tallA);
      await waitLoad();
      let doc = fr.contentDocument;
      if (!doc) return { ok: false, reason: 'no contentDocument' };
      let el = doc.scrollingElement || doc.documentElement;
      el.scrollTop = 0;
      fr.__logStickBottom = false;
      fr.__logScrollTop = 0;
      W.setExecRichIframeSrcdocSticky(fr, tallB);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      doc = fr.contentDocument;
      el = doc.scrollingElement || doc.documentElement;
      const scrolledUpStillNearTop = el.scrollTop < 120;

      el.scrollTop = el.scrollHeight;
      fr.__logStickBottom = true;
      fr.__logScrollTop = el.scrollTop;
      W.setExecRichIframeSrcdocSticky(fr, tallA);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      doc = fr.contentDocument;
      el = doc.scrollingElement || doc.documentElement;
      el.scrollTop = el.scrollHeight;
      fr.__logStickBottom = true;
      W.setExecRichIframeSrcdocSticky(fr, tallB);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      doc = fr.contentDocument;
      el = doc.scrollingElement || doc.documentElement;
      const stuckBottom =
        el.scrollHeight - el.clientHeight - el.scrollTop < 64;

      return { ok: true, scrolledUpStillNearTop, stuckBottom };
    }, { tallA: tallSrcdoc(80), tallB: tallSrcdoc(200) });

    expect(result.ok, result.reason || '').toBeTruthy();
    expect(result.scrolledUpStillNearTop).toBe(true);
    expect(result.stuckBottom).toBe(true);
  });

  test('中间位置分片更新应保留 scrollTop；贴底时仍跟随底部', async ({ page, baseURL }) => {
    const origin = baseURL || 'http://127.0.0.1:8765';
    await gotoUi(page, origin);

    const result = await page.evaluate(async ({ tallA, tallB }) => {
      const W = window.__onlineServiceUiTest;
      if (!W || typeof W.setExecRichIframeSrcdocSticky !== 'function') {
        return { ok: false, reason: 'missing __onlineServiceUiTest' };
      }
      const host = document.createElement('div');
      host.innerHTML =
        '<iframe class="out exec-rich-frame job-raw-frame" data-job-id="e2e-scroll-mid"></iframe>';
      document.body.appendChild(host);
      const fr = /** @type {HTMLIFrameElement} */ (host.querySelector('iframe'));
      if (!fr) return { ok: false, reason: 'no iframe' };

      const waitLoad = () =>
        new Promise((resolve) => {
          fr.addEventListener('load', () => resolve(undefined), { once: true });
          setTimeout(resolve, 80);
        });

      W.setExecRichIframeSrcdocSticky(fr, tallA);
      await waitLoad();
      let doc = fr.contentDocument;
      if (!doc) return { ok: false, reason: 'no contentDocument' };
      let el = doc.scrollingElement || doc.documentElement;
      const mid = Math.max(80, Math.floor((el.scrollHeight - el.clientHeight) / 2));
      el.scrollTop = mid;
      fr.__logStickBottom = false;
      fr.__logScrollTop = el.scrollTop;
      const before = el.scrollTop;
      W.setExecRichIframeSrcdocSticky(fr, tallB);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      doc = fr.contentDocument;
      el = doc.scrollingElement || doc.documentElement;
      const midPreserved = el.scrollTop >= before - 8;

      el.scrollTop = el.scrollHeight;
      fr.__logStickBottom = true;
      fr.__logScrollTop = el.scrollTop;
      W.setExecRichIframeSrcdocSticky(fr, tallA);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      doc = fr.contentDocument;
      el = doc.scrollingElement || doc.documentElement;
      el.scrollTop = el.scrollHeight;
      fr.__logStickBottom = true;
      W.setExecRichIframeSrcdocSticky(fr, tallB);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      doc = fr.contentDocument;
      el = doc.scrollingElement || doc.documentElement;
      const stuckBottom =
        el.scrollHeight - el.clientHeight - el.scrollTop < 64;

      return { ok: true, midPreserved, stuckBottom, before, after: el.scrollTop };
    }, { tallA: tallSrcdoc(80), tallB: tallSrcdoc(200) });

    expect(result.ok, result.reason || '').toBeTruthy();
    expect(result.midPreserved).toBe(true);
    expect(result.stuckBottom).toBe(true);
  });
});

test.describe('cloneOutBanner 滚动', () => {
  test('追加横幅文本时保留中间 scrollTop；贴底时仍跟随', async ({ page, baseURL }) => {
    const origin = baseURL || 'http://127.0.0.1:8765';
    await gotoUi(page, origin);

    const result = await page.evaluate(() => {
      const W = window.__onlineServiceUiTest;
      if (!W || typeof W.setCloneOutBannerText !== 'function') {
        return { ok: false, reason: 'missing setCloneOutBannerText' };
      }
      const ban = document.getElementById('cloneOutBanner');
      if (!ban) return { ok: false, reason: 'missing cloneOutBanner' };

      const tall = Array.from({ length: 40 }, (_, i) => `BANNER_${i}`).join('\n');
      W.setCloneOutBannerText(tall);
      if (ban.scrollHeight <= ban.clientHeight + 4) {
        return { ok: false, reason: 'banner not scrollable', scrollHeight: ban.scrollHeight, clientHeight: ban.clientHeight };
      }

      const mid = Math.max(20, Math.floor((ban.scrollHeight - ban.clientHeight) / 2));
      ban.scrollTop = mid;
      const before = ban.scrollTop;
      W.setCloneOutBannerText('━━ retry mid ━━', { append: true });
      const midPreserved = Math.abs(ban.scrollTop - before) <= 8;

      ban.scrollTop = ban.scrollHeight;
      W.setCloneOutBannerText('━━ retry bottom ━━', { append: true });
      const stuckBottom =
        ban.scrollHeight - ban.clientHeight - ban.scrollTop < 32;

      return { ok: true, midPreserved, stuckBottom, before, after: ban.scrollTop };
    });

    expect(result.ok, result.reason || '').toBeTruthy();
    expect(result.midPreserved).toBe(true);
    expect(result.stuckBottom).toBe(true);
  });
});
