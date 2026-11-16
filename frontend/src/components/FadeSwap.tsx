import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { motionTokens } from "./arc/lib/motion-tokens";

/**
 * 同一块区域换成另一份内容时的交叉淡入，沿用 Arc Skeleton 的内容切换写法与动效参数：
 * 旧内容快速淡出，新内容轻微上移淡入；swapKey 不变时子树原地更新，不卸载、不动画。
 * 只用在「一份内容被等价内容换掉」的地方（例如实时进度 → 已保存的运行记录），系统要求减少动画时只做极短淡入。
 */
export function FadeSwap({ swapKey, children, className }: { swapKey: string; children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <div className={className}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div key={swapKey}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: reduce ? motionTokens.duration.instant : motionTokens.duration.fast } }}
          transition={{ duration: reduce ? motionTokens.duration.instant : motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }}>
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
