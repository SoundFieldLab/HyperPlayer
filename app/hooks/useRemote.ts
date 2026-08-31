import { useEffect, useRef, useState } from "react";
import { remoteFailure, remoteSuccess, type RemoteState } from "../remote";

export function useRemote<T>(
  load: () => Promise<T>,
  deps: React.DependencyList,
  empty: (data: T) => boolean = () => false,
): readonly [RemoteState<T>, () => void] {
  const [state, setState] = useState<RemoteState<T>>({ status: "loading" });
  const generation = useRef(0);

  function run(): void {
    const current = ++generation.current;
    setState({ status: "loading" });
    void load()
      .then((data) => {
        if (current === generation.current) setState(remoteSuccess(data, empty(data)));
      })
      .catch((error: unknown) => {
        if (current === generation.current) setState(remoteFailure(error));
      });
  }

  useEffect(() => {
    run();
    return () => {
      generation.current += 1;
    };
  }, deps);

  return [state, run] as const;
}
