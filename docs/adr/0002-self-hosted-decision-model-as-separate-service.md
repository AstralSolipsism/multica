---
status: accepted
---

# 自部署决策模型以独立的 `/v1/systemone` 服务接入

OL-1013 要用平台自己微调的 Laya 模型替代外部来源，需求写明不把 ONNX Runtime 编进 `multica` 二进制。因此，模型作为独立进程运行，提供与外部来源相同的 `POST /v1/systemone` 接口。服务栈是 Laya 官方的 `laya-serve`，以 FP16 常驻 149 的 GPU：OL-1018 实测后，负责人按方案 A 淘汰了 EdgeJev（见契约文档 §10.0）。daemon 把它当作普通来源 `self-hosted`，经 HTTP 调用。

## 理由

- **daemon 保持纯 Go 静态构建。**
  - daemon 就是 `multica` 二进制。发布构建覆盖 darwin、linux、windows 的 amd64 和 arm64，一律 `CGO_ENABLED=0`（`.goreleaser.yml`；`Dockerfile` 也一样）。
  - 进程内推理要用 Laya 的 Go 绑定 `laya-go`。它的推理模块通过 cgo 调用 ONNX Runtime 1.29+ 的动态库；以 `CGO_ENABLED=0` 构建时，打开模型直接返回 `ErrNoCGO`。
  - 编进去，就要为六个目标平台配 C 交叉编译工具链，还要随 `multica` 分发 onnxruntime 动态库并保证能加载到。
- **换模型不用发 daemon 版本。** 模型会随样本积累反复重训，也可能回滚。每次只换服务的模型目录；daemon 只认协议，不认模型。服务栈也可以换成别的兼容 `/v1/systemone` 的实现。
- **同一台机器上的多个 daemon 共用一份模型。** 149 宿主机上，宿主机和 agent 容器里都有 daemon。模型常驻 GPU 估计要占 1.5–2 GiB 显存（以 OL-1024 实测为准），这张卡可用的 7.6 GiB 还要留给 kb-worker（峰值约 4.25 GiB）。编进 daemon，每个 daemon 都要各占一份显存，卡上放不下；独立服务只载一份，显存、线程和内存的限额也只设一处。
- **与外部来源走同一条路径。** 超时、切换、熔断、健康快照和回退都沿用来源的现有机制，不为自部署来源写特例。服务不可用时，daemon 切到下一个来源或回退，运行不受影响。

## 考虑过的方案

- **用 `laya-go` 把推理编进 daemon**：少一个进程，也省一次本机 HTTP 往返。但 OL-1000 实测本机回环 HTTP 往返约 2ms；GPU 上推理估计几十毫秒，门槛是 P95 < 100ms（以 OL-1023、OL-1024 的实测为准），回环往返只占一小部分。而且 `laya-go` 跑的是 ONNX 模型，方案 A 已经不导出 ONNX；要在 GPU 上推理，还得改用 CUDA 版的 ONNX Runtime。省下的时间不值得放弃上面几点。

## 后果

- 多了一个需要运维的进程。常驻与崩溃重启、线程和内存限额、模型版本与回滚、监听地址与鉴权、日志不记录请求内容，以及与 kb-worker 共用 GPU，都由 OL-1024 落实，写进它的运维手册。
- 只有能访问这个服务的 daemon 才能用自部署来源。不在 149 上的 daemon（agent-gcp-01、shendiqiu02）要接入，需另开 issue。
- 换模型版本、换服务栈或改判据文案之后，都要重跑门禁评测；不通过就把 `self-hosted` 从来源列表的首位撤下。

## 修订

- 2026-10-21，方案 A（OL-1033）：服务栈定为 `laya-serve`，理由里的模型体积和推理耗时按 GPU 上的情况改写。决定本身不变。
