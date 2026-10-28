import { loadRootConfig, saveRootConfig, withConfigFileLock } from '../config/profile-store';
import { modelServiceName, normalizeModelService } from './config';
import { loadModelService } from './service';

export async function listModelServices(configPath: string) {
  return (await loadRootConfig(configPath))?.modelServices ?? {};
}

export async function configureModelService(configPath: string, name: string, input: unknown): Promise<void> {
  modelServiceName(name);
  const config = normalizeModelService(input);
  await withConfigFileLock(configPath, async () => {
    const root = await loadRootConfig(configPath);
    if (!root) throw new Error('找不到 Bridge 配置');
    root.modelServices = { ...root.modelServices, [name]: config };
    await saveRootConfig(root, configPath);
  });
}

export async function removeModelService(configPath: string, name: string): Promise<void> {
  modelServiceName(name);
  await withConfigFileLock(configPath, async () => {
    const root = await loadRootConfig(configPath);
    if (!root) throw new Error('找不到 Bridge 配置');
    if (root.modelServices) delete root.modelServices[name];
    await saveRootConfig(root, configPath);
  });
}

/** Local validation only. Neither credentials nor provider responses leave this boundary. */
export async function checkModelService(configPath: string, name: string) {
  modelServiceName(name);
  const config = (await listModelServices(configPath))[name];
  if (!config) throw new Error('找不到指定的模型服务');
  const { model } = await loadModelService(config);
  return { model, note: '配置与凭据读取通过，尚未请求模型服务' };
}
