/** 旧 useSessionStore 的最小适配：只有画布需要的字段。工作区由 TopologyMount 从新壳 URL 注入。 */
import { create } from "zustand";

interface LegacySessionState {
  currentWorkspaceId: string;
  currentSessionId: string;
  username: string;
  sessionListVersion: number;
  setWorkspace: (ws: string) => void;
  setUsername: (u: string) => void;
  setCurrentSession: (id: string | null) => void;
  bumpSessionList: () => void;
}

export const useSessionStore = create<LegacySessionState>((set) => ({
  currentWorkspaceId: "",
  currentSessionId: "",
  username: "",
  sessionListVersion: 0,
  setWorkspace: (ws) => set({ currentWorkspaceId: ws }),
  setUsername: (u) => set({ username: u }),
  setCurrentSession: (id) => set({ currentSessionId: id ?? "" }),
  bumpSessionList: () => set((s) => ({ sessionListVersion: s.sessionListVersion + 1 })),
}));
