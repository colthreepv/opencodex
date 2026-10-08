import { useCallback, useEffect, useId, useRef, useState, type Ref } from "react";
import { createBoundedFetch, type BoundedFetch } from "../bounded-fetch";
import { readJsonOrThrow } from "../fetch-json";
import { useT, type TKey } from "../i18n/shared";
import type { ModelRow } from "../pages/models-shared";
import { Select } from "../ui";
import {
  EMPTY_BAND,
  EMPTY_RATES,
  INVALID,
  MAX_RATE,
  RATE_FIELDS,
  buildDraftCost,
  isRecord,
  loadDraft,
  parseModelCost,
  receiptMatches,
  type BandDraft,
  type Comparison,
  type InvalidField,
  type ModelCost,
  type PromptPolicy,
  type RateDraft,
  type RateField,
} from "./model-price-cost";

const REQUEST_TIMEOUT_MS = 60_000;
type Phase = "loading" | "loadFailed" | "ready" | "saving" | "unknown" | "refreshing" | "refreshFailed";
const BAND_RATES = RATE_FIELDS;
const POLICIES: PromptPolicy[] = ["automatic", "flat", "custom"];
const RATE_LABELS: Record<RateField, TKey> = {
  input: "pricing.override.input",
  output: "pricing.override.output",
  cacheRead: "pricing.override.cacheRead",
  cacheWrite: "pricing.override.cacheWrite",
};
const POLICY_LABEL: Record<PromptPolicy, TKey> = {
  automatic: "pricing.override.modeAutomatic",
  flat: "pricing.override.modeFlat",
  custom: "pricing.override.modeCustom",
};
const POLICY_HELP: Record<PromptPolicy, TKey> = {
  automatic: "pricing.override.modeAutomaticHelp",
  flat: "pricing.override.modeFlatHelp",
  custom: "pricing.override.modeCustomHelp",
};
const BASE_INVALID: TKey = "pricing.override.invalid";
const FIELD_ERROR: Record<InvalidField, TKey> = {
  input: BASE_INVALID,
  output: BASE_INVALID,
  cacheRead: BASE_INVALID,
  cacheWrite: BASE_INVALID,
  threshold: "pricing.override.invalidThreshold",
  bandInput: "pricing.override.invalidBand",
  bandOutput: "pricing.override.invalidBand",
  bandCacheRead: "pricing.override.invalidBand",
  bandCacheWrite: "pricing.override.invalidBand",
};
const BAND_RATE_FIELD: Record<RateField, InvalidField> = {
  input: "bandInput",
  output: "bandOutput",
  cacheRead: "bandCacheRead",
  cacheWrite: "bandCacheWrite",
};

interface RateInputProps {
  id: string;
  fieldName: InvalidField;
  label: string;
  value: string;
  disabled: boolean;
  invalid: boolean;
  required: boolean;
  "aria-describedby": string;
  inputRef?: Ref<HTMLInputElement>;
  onChange: (value: string) => void;
}

function RateInput({ id, fieldName, label, value, disabled, invalid, required, "aria-describedby": describedBy, inputRef, onChange }: RateInputProps) {
  return (
    <>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input ref={inputRef} id={id} data-price-field={fieldName}
        className="input" type="number" min={0} max={MAX_RATE} step="any" inputMode="decimal"
        value={value} disabled={disabled} required={required}
        aria-describedby={describedBy}
        aria-invalid={invalid ? true : undefined}
        onChange={event => onChange(event.target.value)} />
    </>
  );
}

interface ModelPriceDialogProps {
  model: ModelRow;
  apiBase: string;
  onRefresh: (signal: AbortSignal) => Promise<boolean>;
  onClose: () => void;
}

export default function ModelPriceDialog({ model, apiBase, onRefresh, onClose }: ModelPriceDialogProps) {
  const t = useT();
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef<BoundedFetch | null>(null);
  const mutationPendingRef = useRef(false);
  const [phase, setPhase] = useState<Phase>("loading");
  const [draft, setDraft] = useState<RateDraft>(EMPTY_RATES);
  const [policy, setPolicy] = useState<PromptPolicy>("automatic");
  const [band, setBand] = useState<BandDraft>(EMPTY_BAND);
  const [hasOverride, setHasOverride] = useState(false);
  const [errorKey, setErrorKey] = useState<TKey | null>(null);
  const [invalidField, setInvalidField] = useState<InvalidField | null>(null);
  const [recovered, setRecovered] = useState(false);
  const endpoint = `${apiBase}/api/providers/${encodeURIComponent(model.provider)}/model-costs`;
  const mutating = phase === "saving" || phase === "refreshing";
  const locked = phase !== "ready";

  const clearError = () => {
    setErrorKey(null);
    setInvalidField(null);
  };

  const readOverride = useCallback((recover = false) => {
    if (requestRef.current) return;
    const bounded = createBoundedFetch(REQUEST_TIMEOUT_MS);
    requestRef.current = bounded;
    void fetch(endpoint, { signal: bounded.signal, cache: "no-store" }).then(async response => {
      const result = await readJsonOrThrow<unknown>(response);
      bounded.signal.throwIfAborted();
      if (!isRecord(result) || result.provider !== model.provider || !isRecord(result.modelCosts)) {
        throw new Error("invalid model-costs response");
      }
      const raw = Object.hasOwn(result.modelCosts, model.id) ? result.modelCosts[model.id] : undefined;
      const cost = raw === undefined ? undefined : parseModelCost(raw);
      if (cost === INVALID) throw new Error("invalid model cost");
      if (requestRef.current !== bounded) return;
      const loaded = loadDraft(cost);
      setDraft(loaded.rates);
      setPolicy(loaded.policy);
      setBand(loaded.band);
      setHasOverride(cost !== undefined);
      // This read recovers an editable snapshot, not ordering against an earlier
      // request still running on the server or writes from another client.
      setRecovered(recover);
      setPhase("ready");
    }).catch(() => {
      if (requestRef.current !== bounded) return;
      setPhase(recover ? "unknown" : "loadFailed");
      setErrorKey(recover ? "pricing.override.recoveryFailed" : "pricing.override.loadFailed");
    }).finally(() => {
      bounded.clear();
      if (requestRef.current === bounded) requestRef.current = null;
    });
  }, [endpoint, model.id, model.provider]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    void readOverride();
    return () => {
      requestRef.current?.controller.abort();
      requestRef.current?.clear();
      requestRef.current = null;
      if (dialog?.open) dialog.close();
    };
  }, [readOverride]);

  useEffect(() => {
    if (phase === "ready") inputRef.current?.focus();
    else if (phase === "unknown" || phase === "loadFailed" || phase === "refreshFailed") submitRef.current?.focus();
  }, [phase]);

  // undefined retries only catalog refresh after a validated persistence receipt.
  // null resets the whole row, including any prompt-length pricing.
  const save = async (cost: ModelCost | null | undefined) => {
    if (requestRef.current || (cost === undefined ? phase !== "refreshFailed" : phase !== "ready")) return;
    const bounded = createBoundedFetch(REQUEST_TIMEOUT_MS);
    requestRef.current = bounded;
    setPhase(cost === undefined ? "refreshing" : "saving");
    mutationPendingRef.current = true;
    setErrorKey(null);
    let confirmed = cost === undefined;
    try {
      if (cost !== undefined) {
        const response = await fetch(endpoint, {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ modelId: model.id, cost }), signal: bounded.signal,
        });
        const result = await readJsonOrThrow<unknown>(response);
        bounded.signal.throwIfAborted();
        const receipt = isRecord(result) ? result.cost : undefined;
        if (!isRecord(result) || result.ok !== true || result.provider !== model.provider
          || result.modelId !== model.id || !receiptMatches(receipt, cost)) {
          throw new Error("invalid model-costs receipt");
        }
        if (requestRef.current !== bounded) return;
        confirmed = true;
        setPhase("refreshing");
      }
      if (!await onRefresh(bounded.signal)) throw new Error("catalog refresh failed");
      bounded.signal.throwIfAborted();
      if (requestRef.current === bounded) onClose();
    } catch {
      if (requestRef.current !== bounded) return;
      setPhase(confirmed ? "refreshFailed" : "unknown");
      setErrorKey(confirmed ? "pricing.override.refreshFailed" : "pricing.override.outcomeUnknown");
    } finally {
      bounded.clear();
      if (requestRef.current === bounded) {
        requestRef.current = null;
        mutationPendingRef.current = false;
      }
    }
  };

  const requestClose = () => {
    if (!mutationPendingRef.current) onClose();
  };

  const editBase = (field: RateField, value: string) => {
    if (locked || requestRef.current) return;
    clearError();
    setDraft(current => ({
      ...current,
      cacheRead: current.cacheRead || "0", cacheWrite: current.cacheWrite || "0",
      [field]: value,
    }));
  };

  const editBand = (field: RateField, value: string) => {
    if (locked || requestRef.current) return;
    clearError();
    setBand(current => ({
      ...current,
      cacheRead: current.cacheRead || "0", cacheWrite: current.cacheWrite || "0",
      [field]: value,
    }));
  };

  const updateBand = (patch: Partial<BandDraft>) => {
    if (locked || requestRef.current) return;
    clearError();
    setBand(current => ({ ...current, ...patch }));
  };

  const choosePolicy = (next: PromptPolicy) => {
    if (locked || requestRef.current) return;
    clearError();
    setPolicy(next);
  };

  const focusField = (field: InvalidField) => {
    dialogRef.current?.querySelector<HTMLInputElement>(`[data-price-field="${field}"]`)?.focus();
  };

  return (
    <dialog ref={dialogRef} className="modal-overlay" aria-labelledby={`${id}-title`}
      onCancel={event => { event.preventDefault(); requestClose(); }}>
      <button type="button" className="modal-backdrop-dismiss" tabIndex={-1}
        aria-label={t("pricing.override.close")} disabled={mutating} onClick={requestClose} />
      <form className="modal-card model-display-name-dialog model-price-dialog" role="document" noValidate
        aria-busy={phase === "loading" || mutating}
        onClick={event => event.stopPropagation()}
        onSubmit={event => {
          event.preventDefault();
          if (requestRef.current) return;
          if (phase === "unknown" || phase === "loadFailed") {
            setPhase("loading");
            setErrorKey(null);
            void readOverride(phase === "unknown");
            return;
          }
          if (phase === "refreshFailed") { void save(undefined); return; }
          if (locked) return;
          const badInput = [...event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="number"]')]
            .find(input => input.validity.badInput);
          const outcome = buildDraftCost(draft, policy, band, badInput?.dataset.priceField as InvalidField | undefined);
          if ("field" in outcome) {
            setInvalidField(outcome.field);
            setErrorKey(FIELD_ERROR[outcome.field]);
            focusField(outcome.field);
            return;
          }
          void save(outcome.cost);
        }}>
        <div className="modal-head">
          <h3 id={`${id}-title`}>{t("pricing.override.title")}</h3>
          <button type="button" className="btn btn-ghost btn-sm" disabled={mutating} onClick={requestClose}>
            {t("pricing.override.close")}
          </button>
        </div>
        <div className="model-price-body">
          <div className="model-display-name-identity">
            <span className="muted text-label">{t("pricing.override.modelId")}</span>
            <code className="mono text-control">{model.namespaced}</code>
          </div>
          <p id={`${id}-help`} className="muted small">{t("pricing.override.help")}</p>
          {phase === "loading" && <p role="status" className="muted small">{t("pricing.override.loading")}</p>}
          {RATE_FIELDS.map(field => (
            <RateInput key={field} id={`${id}-${field}`} fieldName={field} label={t(RATE_LABELS[field])}
              value={draft[field]} disabled={locked} invalid={invalidField === field}
              required={field === "input" || field === "output"} aria-describedby={`${id}-help${errorKey ? ` ${id}-error` : ""}`}
              inputRef={field === "input" ? inputRef : undefined}
              onChange={value => editBase(field, value)} />
          ))}
          <fieldset className="model-price-mode" disabled={locked}>
            <legend className="field-label">{t("pricing.override.promptTitle")}</legend>
            <p id={`${id}-prompt-help`} className="muted small">{t("pricing.override.promptHelp")}</p>
            {POLICIES.map(option => (
              <label key={option} className="model-price-mode-option">
                <input type="radio" name={`${id}-policy`} value={option} checked={policy === option}
                  disabled={locked} aria-describedby={`${id}-mode-${option}`}
                  onChange={() => choosePolicy(option)} />
                <span>
                  <span className="text-label">{t(POLICY_LABEL[option])}</span>
                  <span id={`${id}-mode-${option}`} className="muted small">{t(POLICY_HELP[option])}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {policy === "custom" && (
            <div className="model-price-band" role="group" aria-labelledby={`${id}-band-title`}>
              <p id={`${id}-band-title`} className="text-label model-price-band-title">{t("pricing.override.bandTitle")}</p>
              <p id={`${id}-band-help`} className="muted small">{t("pricing.override.bandHelp")}</p>
              <label className="field-label" htmlFor={`${id}-threshold`}>{t("pricing.override.threshold")}</label>
              <input id={`${id}-threshold`} data-price-field="threshold" className="input" type="number"
                min={1} step={1} inputMode="numeric" value={band.threshold} disabled={locked} required
                aria-describedby={`${id}-band-help${errorKey ? ` ${id}-error` : ""}`}
                aria-invalid={invalidField === "threshold" ? true : undefined}
                onChange={event => updateBand({ threshold: event.target.value })} />
              <label className="field-label" htmlFor={`${id}-comparison`}>{t("pricing.override.comparison")}</label>
              <Select id={`${id}-comparison`} value={band.comparison} disabled={locked}
                options={[
                  { value: "gt", label: t("pricing.override.comparisonGt") },
                  { value: "gte", label: t("pricing.override.comparisonGte") },
                ]}
                onChange={value => updateBand({ comparison: value === "gte" ? "gte" : "gt" as Comparison })} />
              {BAND_RATES.map(field => (
                <RateInput key={field} id={`${id}-band-${field}`} fieldName={BAND_RATE_FIELD[field]}
                  label={t(RATE_LABELS[field])} value={band[field]} disabled={locked}
                  invalid={invalidField === BAND_RATE_FIELD[field]}
                  required={field === "input" || field === "output"} aria-describedby={`${id}-band-help${errorKey ? ` ${id}-error` : ""}`}
                  onChange={value => editBand(field, value)} />
              ))}
            </div>
          )}
        </div>
        {recovered && <p role="status" className="muted small">{t("pricing.override.recovered")}</p>}
        {errorKey && <p id={`${id}-error`} className="model-display-name-error" role="alert">{t(errorKey)}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost btn-sm" disabled={locked || !hasOverride}
            onClick={() => void save(null)}>{t("pricing.override.reset")}</button>
          <button type="button" className="btn btn-sm" disabled={mutating} onClick={requestClose}>
            {t("pricing.override.cancel")}
          </button>
          <button ref={submitRef} type="submit" className="btn btn-primary btn-sm" disabled={phase === "loading" || mutating}>
            {t(mutating ? "pricing.override.saving" : phase === "unknown" || phase === "loadFailed"
              ? "pricing.override.reload" : phase === "refreshFailed" ? "pricing.override.refresh" : "pricing.override.save")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
