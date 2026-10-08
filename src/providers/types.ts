import type { Offer, Payment } from "../domain/model.js";
export type Checkout = { id: string; url: string; testMode: boolean };
export type VerifiedEvent = { id: string; type: string; testMode: boolean; checkoutId?: string };
export type CheckoutState = {
  checkoutId: string; paymentId?: string; providerLinkId?: string; versionId?: string; offerId?: string;
  siteId?: string; pluginId?: string; amount: number | null; currency: string | null;
  status: Payment["status"]; testMode: boolean;
  customer?: { providerCustomerId?: string; email?: string; name?: string; country?: string };
};
export interface PaymentProvider {
  readonly name: "stripe";
  readonly testMode: boolean;
  createOfferLink(offer: Offer, site: string, successUrl: string, operationId: string): Promise<Checkout>;
  setLinkActive(id: string, active: boolean, operationId: string): Promise<void>;
  readCheckout(id: string): Promise<CheckoutState>;
  verifyWebhook(bytes: Uint8Array, signature: string, secret: string): Promise<VerifiedEvent>;
  testConnection(): Promise<void>;
}
