// @ts-check
/** 临时配置：使用 bundled chromium（无 channel: chrome） */
export default {
  testDir: 'e2e',
  use: {
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:8765',
    browserName: 'chromium',
  },
};
