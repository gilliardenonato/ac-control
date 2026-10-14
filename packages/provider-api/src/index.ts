import type { AttributePatch, Capabilities, DeviceEvent, EnergyCapabilities, EnergyPoint, EnergyQuery, NormalizedState, ProviderHealth } from "@acc/domain";

export interface ProviderDevice { externalId: string; name: string; model?: string }
export type Unsubscribe = () => void;

/**
 * Porta para fabricantes. Implementações lançam ProviderError (kind normalizado).
 * Eventos e estados sempre usam o vocabulário do domínio; nada de JSON do fabricante vaza.
 */
export interface ACProvider {
  readonly id: string;
  getDevices(): Promise<ProviderDevice[]>;
  getCapabilities(externalId: string): Promise<Capabilities>;
  /** Estado completo (todos os campos que o aparelho informa). */
  getState(externalId: string): Promise<NormalizedState>;
  /** Valida contra capabilities e envia. Só o CommandGateway chama. */
  setAttributes(externalId: string, patch: AttributePatch): Promise<void>;
  getEnergyCapabilities(externalId: string): Promise<EnergyCapabilities>;
  getEnergyUsage(externalId: string, q: EnergyQuery): Promise<EnergyPoint[]>;
  /** Eventos usam externalId em `deviceId`; a camada de aplicação mapeia para o id interno. */
  subscribeEvents(handler: (e: DeviceEvent | ProviderHealth) => void): Promise<Unsubscribe>;
}
