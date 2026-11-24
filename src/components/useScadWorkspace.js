import { useEffect, useRef, useState } from 'react';

const IDLE = { status: 'idle', processed: 0, total: 0, current: null };
const NO_VALUES = Object.freeze({});

const errorText = error => error?.message?.replace(/^Error invoking remote method '[^']+': Error: /, '') || String(error);

export default function useScadWorkspace(item, onError) {
  const itemId = item?.id;
  const modelKey = item ? `${item.id}:${item.modifiedAt}:${item.missing}` : null;
  const [parameters, setParameters] = useState(null);
  const [draft, setDraft] = useState(null);
  const [preview, setPreview] = useState(null);
  const [exportRun, setExportRun] = useState(null);
  const inFlight = useRef(false);
  const values = draft?.key === modelKey ? draft.values : NO_VALUES;

  useEffect(() => {
    if (!itemId || item.missing) return;
    let cancelled = false;
    window.nine.getScadParameters(itemId).then(info => {
      if (!cancelled) setParameters({ key: modelKey, info });
    }).catch(error => {
      if (!cancelled) setParameters({ key: modelKey, info: { parameters: [], selector: null, supported: false, diagnostics: [errorText(error)] } });
    });
    return () => { cancelled = true; };
  }, [itemId, modelKey]);

  useEffect(() => {
    return window.nine?.onScadExport?.(progress => {
      setExportRun(run => run?.state.status === 'running'
        ? { ...run, state: { ...progress, status: 'running' } }
        : run);
    });
  }, []);

  async function exportModel({ selector, parts }) {
    if (!itemId || inFlight.current) return;
    inFlight.current = true;
    setExportRun({ key: modelKey, state: { ...IDLE, status: 'running', total: parts?.length ?? 1 } });
    try {
      const result = await window.nine.exportScad(itemId, { values, selector, parts });
      setExportRun({ key: modelKey, state: IDLE, result });
    } catch (error) {
      setExportRun({ key: modelKey, state: IDLE });
      onError(errorText(error));
    } finally {
      inFlight.current = false;
    }
  }

  return {
    parametersInfo: parameters?.key === modelKey ? parameters.info : null,
    values,
    previewValues: preview?.key === modelKey ? preview.values : NO_VALUES,
    setValues: next => setDraft({ key: modelKey, values: next }),
    resetValues: () => {
      setDraft({ key: modelKey, values: NO_VALUES });
      setPreview({ key: modelKey, values: NO_VALUES });
    },
    applyPreview: () => setPreview({ key: modelKey, values }),
    exportState: exportRun?.state || IDLE,
    exportResult: exportRun?.key === modelKey ? exportRun.result : undefined,
    exportModel,
    cancelExport: () => window.nine.cancelScadExport().catch(error => onError(errorText(error))),
  };
}
