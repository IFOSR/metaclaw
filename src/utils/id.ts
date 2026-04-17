import { nanoid } from 'nanoid';

/**
 * 生成任务 ID
 */
export function generateTaskId(): string {
  return `task_${nanoid(10)}`;
}

/**
 * 生成偏好 ID
 */
export function generatePreferenceId(): string {
  return `pref_${nanoid(10)}`;
}

/**
 * 生成观察记录 ID
 */
export function generateObservationId(): string {
  return `obs_${nanoid(10)}`;
}

/**
 * 生成交互记录 ID
 */
export function generateInteractionId(): string {
  return `int_${nanoid(10)}`;
}

/**
 * 生成偏好使用记录 ID
 */
export function generateUsageId(): string {
  return `usage_${nanoid(10)}`;
}
