"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useSteppedVisualization } from "@/hooks/useSteppedVisualization";
import { StepControls } from "@/components/visualizations/shared/step-controls";

interface SkillEntry {
  name: string;
  summary: string;
  fullTokens: number;
  content: string[];
}

const SKILLS: SkillEntry[] = [
  {
    name: "/commit",
    summary: "按照仓库规范创建 git 提交",
    fullTokens: 320,
    content: [
      "1. 运行 git status + git diff 查看更改",
      "2. 分析所有暂存的更改并起草提交信息",
      "3. 创建提交并添加 Co-Authored-By trailer",
      "4. 提交后运行 git status 验证",
    ],
  },
  {
    name: "/review-pr",
    summary: "审查 Pull Request 的 bug 和代码风格",
    fullTokens: 480,
    content: [
      "1. 通过 gh pr view 获取 PR diff",
      "2. 逐文件分析更改以发现问题",
      "3. 检查 bug、安全问题和风格问题",
      "4. 通过 gh pr review 发布审查评论",
    ],
  },
  {
    name: "/test",
    summary: "运行和分析测试套件",
    fullTokens: 290,
    content: [
      "1. 从 package.json 检测测试框架",
      "2. 运行测试套件并捕获输出",
      "3. 分析失败并建议修复方案",
      "4. 应用修复后重新运行",
    ],
  },
  {
    name: "/deploy",
    summary: "将应用部署到目标环境",
    fullTokens: 350,
    content: [
      "1. 部署前验证所有测试通过",
      "2. 构建生产环境包",
      "3. 通过 CI 推送到部署目标",
      "4. 验证部署 URL 的健康检查",
    ],
  },
];

const TOKEN_STATES = [120, 120, 440, 440, 780, 780];
const MAX_TOKEN_DISPLAY = 1000;

const STEPS = [
  {
    title: "第一层: 精简摘要",
    description:
      "所有技能在系统提示中以摘要形式呈现。精简、常驻。",
  },
  {
    title: "技能调用",
    description:
      "模型识别技能调用并触发 Skill 工具。",
  },
  {
    title: "第二层: 完整注入",
    description:
      "完整的技能指令作为 tool_result 注入，而不是注入到系统提示中。",
  },
  {
    title: "已在上下文中",
    description:
      "详细指令就像工具返回的一样出现。模型精确遵循它们。",
  },
  {
    title: "堆叠技能",
    description:
      "可以加载多个技能。只有摘要是永久的；完整内容来来去去。",
  },
  {
    title: "双层架构",
    description:
      "第一层：常驻，精小。第二层：按需加载，详细。优雅的分离。",
  },
];

export default function SkillLoading({ title }: { title?: string }) {
  const {
    currentStep,
    totalSteps,
    next,
    prev,
    reset,
    isPlaying,
    toggleAutoPlay,
  } = useSteppedVisualization({ totalSteps: STEPS.length, autoPlayInterval: 2500 });

  const tokenCount = TOKEN_STATES[currentStep];
  const highlightedSkill = currentStep >= 1 && currentStep <= 3 ? 0 : currentStep >= 4 ? 1 : -1;
  const showFirstContent = currentStep >= 2;
  const showSecondContent = currentStep >= 4;
  const firstContentFaded = currentStep >= 5;

  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {title || "按需技能加载"}
      </h2>

      <div
        className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-700 dark:bg-zinc-900"
        style={{ minHeight: 500 }}
      >
        <div className="flex gap-6">
          {/* Main content area */}
          <div className="flex-1 space-y-4">
            {/* System Prompt Block */}
            <div>
              <div className="mb-2 flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-zinc-400" />
                <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  系统提示
                </span>
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 dark:bg-zinc-800">
                  常驻
                </span>
              </div>
              <div className="rounded-lg border border-zinc-300 bg-zinc-900 p-4 dark:border-zinc-600">
                <div className="mb-2 font-mono text-[10px] text-zinc-500">
                  # 可用技能
                </div>
                <div className="space-y-1.5">
                  {SKILLS.map((skill, i) => {
                    const isHighlighted = i === highlightedSkill;
                    return (
                      <motion.div
                        key={skill.name}
                        animate={{
                          boxShadow: isHighlighted
                            ? "0 0 12px 2px rgba(59, 130, 246, 0.5)"
                            : "0 0 0 0px rgba(59, 130, 246, 0)",
                        }}
                        transition={{ duration: 0.4 }}
                        className={`rounded px-3 py-1.5 font-mono text-xs transition-colors ${
                          isHighlighted
                            ? "bg-blue-900/60 text-blue-300"
                            : "bg-zinc-800 text-zinc-400"
                        }`}
                      >
                        <span className="font-semibold text-zinc-200">
                          {skill.name}
                        </span>
                        {" - "}
                        {skill.summary}
                      </motion.div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* User invocation indicator */}
            <AnimatePresence>
              {currentStep === 1 && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 dark:border-blue-800 dark:bg-blue-950/30"
                >
                  <span className="text-xs text-blue-600 dark:text-blue-400">
                    用户输入:
                  </span>
                  <code className="rounded bg-blue-100 px-2 py-0.5 text-xs font-bold text-blue-800 dark:bg-blue-900/50 dark:text-blue-200">
                    /commit
                  </code>
                </motion.div>
              )}
              {currentStep === 4 && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 dark:border-blue-800 dark:bg-blue-950/30"
                >
                  <span className="text-xs text-blue-600 dark:text-blue-400">
                    用户输入:
                  </span>
                  <code className="rounded bg-blue-100 px-2 py-0.5 text-xs font-bold text-blue-800 dark:bg-blue-900/50 dark:text-blue-200">
                    /review-pr
                  </code>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Connecting arrow */}
            <AnimatePresence>
              {(showFirstContent || showSecondContent) && (
                <motion.div
                  initial={{ opacity: 0, scaleY: 0 }}
                  animate={{ opacity: 1, scaleY: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex justify-center"
                >
                  <div className="flex flex-col items-center">
                    <div className="h-6 w-px bg-blue-400 dark:bg-blue-500" />
                    <div className="h-0 w-0 border-l-[5px] border-r-[5px] border-t-[6px] border-l-transparent border-r-transparent border-t-blue-400 dark:border-t-blue-500" />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Expanded Skill Content Blocks */}
            <div className="space-y-3">
              <AnimatePresence>
                {showFirstContent && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{
                      opacity: firstContentFaded ? 0.4 : 1,
                      height: "auto",
                    }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.4 }}
                    className="overflow-hidden"
                  >
                    <div className="rounded-lg border-2 border-blue-300 bg-white p-4 dark:border-blue-700 dark:bg-zinc-800">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-2 rounded-full bg-blue-500" />
                          <span className="text-xs font-bold text-blue-700 dark:text-blue-300">
                            SKILL.md: /commit
                          </span>
                        </div>
                        <span className="rounded bg-blue-100 px-1.5 py-0.5 font-mono text-[10px] text-blue-600 dark:bg-blue-900/40 dark:text-blue-300">
                          工具结果
                        </span>
                      </div>
                      <div className="space-y-1">
                        {SKILLS[0].content.map((line, i) => (
                          <motion.div
                            key={i}
                            initial={{ opacity: 0, x: -8 }}
                            animate={{
                              opacity: firstContentFaded ? 0.5 : 1,
                              x: 0,
                            }}
                            transition={{ delay: i * 0.08 }}
                            className="font-mono text-xs text-zinc-600 dark:text-zinc-300"
                          >
                            {line}
                          </motion.div>
                        ))}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {showSecondContent && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.4 }}
                    className="overflow-hidden"
                  >
                    <div className="rounded-lg border-2 border-purple-300 bg-white p-4 dark:border-purple-700 dark:bg-zinc-800">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-2 rounded-full bg-purple-500" />
                          <span className="text-xs font-bold text-purple-700 dark:text-purple-300">
                            SKILL.md: /review-pr
                          </span>
                        </div>
                        <span className="rounded bg-purple-100 px-1.5 py-0.5 font-mono text-[10px] text-purple-600 dark:bg-purple-900/40 dark:text-purple-300">
                          工具结果
                        </span>
                      </div>
                      <div className="space-y-1">
                        {SKILLS[1].content.map((line, i) => (
                          <motion.div
                            key={i}
                            initial={{ opacity: 0, x: -8 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: i * 0.08 }}
                            className="font-mono text-xs text-zinc-600 dark:text-zinc-300"
                          >
                            {line}
                          </motion.div>
                        ))}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Mechanism annotation on step 3 */}
            <AnimatePresence>
              {currentStep === 3 && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
                >
                  Skill 工具将内容作为 tool_result 消息返回。
                  模型在上下文中看到它并遵循指令。
                  系统提示不会膨胀。
                </motion.div>
              )}
            </AnimatePresence>

            {/* Final overview label on step 5 */}
            <AnimatePresence>
              {currentStep === 5 && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex gap-3"
                >
                  <div className="flex-1 rounded border border-zinc-200 bg-zinc-50 p-2 text-center dark:border-zinc-700 dark:bg-zinc-800">
                    <div className="text-[10px] font-semibold text-zinc-500 dark:text-zinc-400">
                      LAYER 1
                    </div>
                    <div className="text-xs text-zinc-600 dark:text-zinc-300">
                      常驻，约 120 tokens
                    </div>
                  </div>
                  <div className="flex-1 rounded border border-blue-200 bg-blue-50 p-2 text-center dark:border-blue-700 dark:bg-blue-900/20">
                    <div className="text-[10px] font-semibold text-blue-500 dark:text-blue-400">
                      LAYER 2
                    </div>
                    <div className="text-xs text-blue-600 dark:text-blue-300">
                      按需加载，每个约 300-500 tokens
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Token Gauge (vertical bar on the right) */}
          <div className="flex w-16 flex-col items-center">
            <div className="mb-1 text-center font-mono text-[10px] text-zinc-400">
              Tokens
            </div>
            <div
              className="relative w-8 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
              style={{ height: 300 }}
            >
              <motion.div
                animate={{
                  height: `${(tokenCount / MAX_TOKEN_DISPLAY) * 100}%`,
                }}
                transition={{ duration: 0.5 }}
                className={`absolute bottom-0 w-full rounded-full ${
                  tokenCount > 600
                    ? "bg-amber-500"
                    : tokenCount > 300
                      ? "bg-blue-500"
                      : "bg-emerald-500"
                }`}
              />
            </div>
            <motion.div
              key={tokenCount}
              initial={{ scale: 0.8 }}
              animate={{ scale: 1 }}
              className="mt-2 text-center font-mono text-xs font-semibold text-zinc-600 dark:text-zinc-300"
            >
              {tokenCount}
            </motion.div>
          </div>
        </div>

        {/* Step Controls */}
        <div className="mt-6">
          <StepControls
            currentStep={currentStep}
            totalSteps={totalSteps}
            onPrev={prev}
            onNext={next}
            onReset={reset}
            isPlaying={isPlaying}
            onToggleAutoPlay={toggleAutoPlay}
            stepTitle={STEPS[currentStep].title}
            stepDescription={STEPS[currentStep].description}
          />
        </div>
      </div>
    </section>
  );
}
