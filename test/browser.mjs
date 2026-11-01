/**
 * @fileoverview CLI の描画テストで使う Chromium 系ブラウザーを検出する。
 * CI は playwright-core が導入した Chromium を使用し、ローカルでは Edge / Chrome も使用できる。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

/**
 * 明示された実行ファイル、Playwright の Chromium、Windows の Edge / Chrome の順に選ぶ。
 * 明示パスが間違っている場合はテストをスキップせず起動失敗として扱う。
 * @returns 描画に使用する実行ファイルのパス。見つからない場合は undefined。
 */
export function findTestBrowser() {
  if (process.env.MVE_TEST_BROWSER) return process.env.MVE_TEST_BROWSER;
  return [
    chromium.executablePath(),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].find((candidate) => candidate && existsSync(candidate));
}
