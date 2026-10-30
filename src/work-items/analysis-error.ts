import { BackgroundExecutionError } from '../runtime/background-executor';

const reasons = {
  rate_limit: '模型服务限流（429），本次分析未完成；请稍后在工作台重试',
  transient: '模型服务暂时不可用，本次分析未完成；请稍后在工作台重试',
  quota: '模型服务额度不足，请恢复额度后在工作台重试',
  authentication: '模型服务授权失败，请检查授权后重试',
  timeout: '分析已达到本次时间上限，请在工作台重试',
  cancelled: '分析已取消',
  invalid_result: '分析结果格式不完整，请在工作台重试',
  incomplete: '分析未返回完整结果，请在工作台重试',
  agent: '模型调用失败，详情已记录；请在工作台重试',
};

/** Only reviewed messages may cross from runtime failures into the result. */
export class WorkItemAnalysisError extends Error {
  constructor(readonly code: keyof typeof reasons) {
    super(reasons[code]);
  }
}

export function backgroundAnalysisError(error: unknown): unknown {
  if (!(error instanceof BackgroundExecutionError)) return error;
  const code = error.code;
  return new WorkItemAnalysisError(
    code === 'runtime' || code === 'delivery_unknown' || code === 'unsupported' ? 'agent' : code,
  );
}

export function analysisFailureReason(error: unknown): string {
  return error instanceof WorkItemAnalysisError
    ? error.message
    : '分析执行失败，详情已记录；请在工作台重试';
}
