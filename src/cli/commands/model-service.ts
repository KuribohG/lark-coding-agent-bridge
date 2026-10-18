import { readFile } from 'node:fs/promises';
import { resolveAppPaths } from '../../config/app-paths';
import { checkModelService, configureModelService, listModelServices, removeModelService } from '../../model-service/registry';

type Options = { config?: string };
const path = (opts: Options) => opts.config ?? resolveAppPaths().configFile;

export async function listServices(opts: Options): Promise<void> {
  console.log(JSON.stringify(await listModelServices(path(opts)), null, 2));
}
export async function configureService(name: string, file: string, opts: Options): Promise<void> {
  let config: unknown;
  try { config = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error('无法读取模型服务 JSON 配置'); }
  await configureModelService(path(opts), name, config);
  console.log('模型服务配置已保存；尚未请求模型服务。');
}
export async function removeService(name: string, opts: Options): Promise<void> {
  await removeModelService(path(opts), name);
  console.log('模型服务引用已删除；凭据文件未删除。');
}
export async function checkService(name: string, opts: Options): Promise<void> {
  console.log(JSON.stringify(await checkModelService(path(opts), name), null, 2));
}
