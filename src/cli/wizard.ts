import { registerApp } from '@larksuite/channel';
import qrcode from 'qrcode-terminal';
import type { AppConfig, TenantBrand } from '../config/schema';
import type { ProfileBootstrapPrompts } from '../runtime/profile-runtime';
import { promptPassword } from './prompt';

async function runRegistrationWizard(): Promise<AppConfig> {
  console.log('\n未检测到飞书应用配置，进入扫码创建向导。\n');

  const result = await registerApp({
    source: 'lark-channel-bridge',
    onQRCodeReady: (info) => {
      console.log('请用飞书 App 扫描以下二维码完成应用创建：\n');
      qrcode.generate(info.url, { small: true });
      const mins = Math.max(1, Math.round(info.expireIn / 60));
      console.log(`\n二维码有效期：约 ${mins} 分钟`);
      console.log(`也可以直接在浏览器打开：${info.url}\n`);
    },
    onStatusChange: (info) => {
      if (info.status === 'domain_switched') {
        console.log('识别到国际版租户，已切换到 larksuite.com 域名。');
      } else if (info.status === 'slow_down') {
        console.log('轮询速度过快，已自动降速。');
      }
    },
  });

  const tenant: TenantBrand = result.user_info?.tenant_brand ?? 'feishu';
  const operatorOpenId = result.user_info?.open_id;

  console.log('\n✓ 应用创建成功');
  console.log(`  App ID:  ${result.client_id}`);
  console.log(`  Tenant:  ${tenant}`);
  if (operatorOpenId) {
    console.log(`  Creator: ${operatorOpenId} (Lark 应用 owner，自动豁免访问控制)`);
  } else {
    console.log('  ⚠️ 未拿到扫码用户的 open_id；启动后会通过应用 owner API 解析创建者。');
  }

  // No access fields are seeded here: the bot creator is resolved at runtime
  // from the Lark application API, and the QR scanner is the app's owner.

  const cfg: AppConfig = {
    accounts: {
      app: {
        id: result.client_id,
        secret: result.client_secret,
        tenant,
      },
    },
  };

  console.log('');
  return cfg;
}

/** Terminal prompts used when a CLI command bootstraps the first profile. */
export const terminalBootstrapPrompts: ProfileBootstrapPrompts = {
  registerApp: runRegistrationWizard,
  appSecret: appId => promptPassword(`输入 ${appId} 的 App Secret: `),
};
