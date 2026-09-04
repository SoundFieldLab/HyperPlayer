// DSP 工作台（D34 Q4）：HSE 自带 MixingStudio UI + HyperPlayer 容器。
// 引擎桥接 HSE 宿主（playbackService.getHseHost）；未初始化时用独立引擎兜底，
// 保证工作台在未播放状态下也可调参。视觉统一（theme.ts 令牌、lucide→Phosphor）
// 在后续 UI 波次做，不在此改 HSE UI 结构。

import { useMemo } from "react";
import { createEngine } from "hypersoundengine";
import {
  HyperSoundEngineMixingStudio,
  createHyperSoundEngineUiBridge,
} from "hypersoundengine/ui";
import { Page } from "../components/ui";
import { playbackService } from "../services/playback/playbackService";
import { useAppStore } from "../store";

export function DspWorkbenchView(): React.JSX.Element {
  const navigate = useAppStore((state) => state.navigate);
  const theme = useAppStore((state) => state.settings?.theme ?? "dark");

  const bridge = useMemo(() => {
    const host = playbackService.getHseHost();
    if (host) {
      return createHyperSoundEngineUiBridge(host.engine, host.engine.getParams().sampleRate || 48000);
    }
    // 未播放/宿主未初始化：独立引擎兜底（参数面与渲染链一致，revision 语义由宿主接管）
    const engine = createEngine(48000, 2);
    return createHyperSoundEngineUiBridge(engine, 48000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackService.getHseHost()]);

  const playerTheme = theme === "light" ? "light" : "dark";

  return (
    <Page title="音效工作台" subtitle="HSE 实时处理链 · 参数变更经宿主交叉淡变生效">
      <HyperSoundEngineMixingStudio
        bridge={bridge}
        playerTheme={playerTheme}
        onClose={() => navigate("home")}
        anchorRect={null}
        exportWav={null}
        exporting={false}
      />
    </Page>
  );
}
