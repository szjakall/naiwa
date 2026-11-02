package harness

import "errors"

// 取消原因：让"运行被中断"这条活动能说清楚是谁中断的。
//
// 以前 ctx 一取消就只剩一句「任务暂停 / 终止 / 重启所致；未完成」，用户无法判断
// 是自己暂停、任务判定完成、超时收尾，还是服务重启。引擎在 cancel 时带上这些
// 哨兵错误，capture 用 context.Cause 读出来给出精确文案。
var (
	ErrCancelPaused   = errors.New("task paused by user")
	ErrCancelDone     = errors.New("task judged done")
	ErrCancelSettled  = errors.New("task settling after timeout")
	ErrCancelKilled   = errors.New("work killed by planner")
	ErrCancelShutdown = errors.New("server shutting down")
	ErrCancelStopped  = errors.New("turn stopped by user")
)