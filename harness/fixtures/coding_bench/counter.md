在 {{PROJECT_DIR}} 从零实际实现原生 HTML/JavaScript 计数器，不能只给方案。
不读取、复制或修改 LZCore 源码、凭据或服务配置；只在本压测工作区创建工程。
显示 data-testid="value" 的整数；可访问按钮 Increment、Decrement、Reset，可访问名称必须分别精确等于这三个名称（不要用较长 aria-label 覆盖名称）。
默认 0，Increment 加 1，Decrement 减 1 但最低 0，Reset 归 0，刷新后保留数值。
无外部依赖。有 package.json，npm test 实际测试计数器逻辑，npm run build 生成 dist/index.html 和所需脚本。
创建所有源码，自行运行并修复测试与构建。后台 HTTP 预览 {{PREVIEW_ORIGIN}}，PID 写 server.pid，输入输出重定向，不能阻塞工具或监听其他网络地址。
必须使用 browser.manage 实际验证点击、反复加减、归零、刷新持久化和控制台。被策略拦截时报告事实，不能绕过策略或将未测项说成 PASS。
最终给项目路径、真实测试/构建/浏览器结果与未验证范围。
