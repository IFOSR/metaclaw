# Manual 02: Result Aggregation And Next Step

## Goal

验证任务完成后，用户看到的是任务级摘要与下一步，而不只是执行器日志。

## Steps

1. 创建一个会返回较长结果的任务
2. 等待任务完成
3. 运行 `/task <id>`

## Expected

- 任务详情中能看到最新结果摘要
- 任务详情中能看到下一步建议
- transcript 可保留原始输出，但任务详情必须可快速阅读

## Fail Examples

- 任务详情只有原始日志，没有任务级摘要
- 用户无法分辨“结果是什么”和“下一步是什么”
