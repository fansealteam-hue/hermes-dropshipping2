// Shared contracts — all sessions import from here

// ─── Products ────────────────────────────────────────────────────────────────

export type WarehouseStatus = "local" | "china" | "unknown";

export interface TemuVariant {
  variantId: string;
  sku: string;
  label: string; // e.g. "Perceuse seule" | "Pack avec batterie"
  costEur: number;
  stock: number;
  imageUrls: string[];
}

export interface TemuProduct {
  temuUrl: string;
  temuItemId: string;
  title: string;
  warehouseStatus: WarehouseStatus;
  variants: TemuVariant[];
  fetchedAt: string; // ISO-8601
}

// ─── Listings ─────────────────────────────────────────────────────────────────

export type ListingStatus =
  | "draft"
  | "scheduled"
  | "published"
  | "paused"
  | "sold"
  | "archived";

export type Channel = "leboncoin"; // Vinted removed from active flows, data preserved

export interface LeboncoinAccount {
  accountId: string;
  label: string; // display name
}

export interface Listing {
  listingId: string;
  channel: Channel;
  accountId: string;
  temuItemId: string;
  variantId: string;
  title: string;
  description: string;
  priceEur: number;
  costEur: number;
  mediaUrls: string[];
  status: ListingStatus;
  scheduledAt?: string; // ISO-8601
  publishedAt?: string;
  leboncoinAdId?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Sales ────────────────────────────────────────────────────────────────────

export type SaleStatus =
  | "confirmed"
  | "order_placed"
  | "tracking_added"
  | "shipped"
  | "delivered"
  | "closed";

export interface Sale {
  saleId: string;
  listingId: string;
  channel: Channel;
  accountId: string;
  temuItemId: string;
  variantId: string;
  supplierUrl: string;
  salePriceEur: number;
  costEur: number;
  status: SaleStatus;
  buyerName?: string;
  deliveryAddress?: string; // kept minimal — no real data in vault
  orderRef?: string; // supplier order reference (added by user)
  trackingNumber?: string;
  trackingCarrier?: string;
  leboncoinDeliveryConfirmed?: boolean;
  manualActionRequired?: boolean;
  manualActionNote?: string;
  confirmedAt: string;
  updatedAt: string;
}

// ─── Telegram interactions ────────────────────────────────────────────────────

export type BotState =
  | "idle"
  | "awaiting_temu_link"
  | "awaiting_variant_choice"
  | "awaiting_price_confirm"
  | "awaiting_account_choice"
  | "awaiting_schedule"
  | "awaiting_order_ref"
  | "awaiting_tracking";

export interface BotSession {
  chatId: number;
  state: BotState;
  pendingTemuUrl?: string;
  pendingProduct?: TemuProduct;
  pendingVariantId?: string;
  pendingListingDraft?: Partial<Listing>;
  pendingSaleId?: string;
  updatedAt: string;
}

// ─── API contracts ────────────────────────────────────────────────────────────

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

// POST /api/products/fetch
export interface FetchProductRequest {
  temuUrl: string;
}
export type FetchProductResponse = ApiResponse<TemuProduct>;

// POST /api/listings
export interface CreateListingRequest {
  temuItemId: string;
  variantId: string;
  accountId: string;
  priceEur: number;
  scheduledAt?: string;
}
export type CreateListingResponse = ApiResponse<Listing>;

// PATCH /api/sales/:saleId/tracking
export interface AddTrackingRequest {
  orderRef: string;
  trackingNumber: string;
  trackingCarrier?: string;
}
export type AddTrackingResponse = ApiResponse<Sale>;

// GET /api/dashboard
export interface DashboardData {
  pendingListings: Listing[];
  activeSales: Sale[];
  salesNeedingAction: Sale[];
  recentActivity: ActivityItem[];
}

export interface ActivityItem {
  timestamp: string;
  type: "listing_published" | "sale_confirmed" | "tracking_added" | "delivery_confirmed";
  description: string;
  saleId?: string;
  listingId?: string;
}
