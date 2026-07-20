export type MatchMode = "ALL" | "ANY";

export type ConditionField =
  | "subtotal"
  | "product"
  | "variant"
  | "sku"
  | "product_tag"
  | "vendor"
  | "product_type"
  | "collection"
  | "customer_tag"
  | "customer_logged_in"
  | "country"
  | "quantity"
  | "discount_code"
  | "distinct_products";

export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "greater_or_equal"
  | "less_than"
  | "less_or_equal"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "in";

export interface RuleCondition {
  id?: string;
  field: ConditionField;
  operator: ConditionOperator;
  value: string | number | boolean | string[];
}

export interface GiftChoice {
  productId?: string;
  productTitle?: string;
  variantId: string;
  variantTitle?: string;
  quantity?: number;
  discountType?: "FREE" | "PERCENT_OFF" | "FIXED_OFF";
  discountValue?: number;
}

export interface CustomerRestrictions {
  onePerOrder?: boolean;
  onePerCustomer?: boolean;
  firstPurchaseOnly?: boolean;
  allowedCustomerTags?: string[];
  excludedCustomerTags?: string[];
}

export interface PriceTier {
  minQuantity: number;
  adjustmentType: "PERCENT_OFF" | "FIXED_OFF" | "FIXED_PRICE";
  value: number;
}

export interface BogoConfiguration {
  enabled?: boolean;
  buyQuantity?: number;
  freeQuantity?: number;
  target?: "SAME_BOX" | "DIFFERENT_BOX";
  targetBoxId?: string;
  pool?: "SAME_POOL" | "DIFFERENT_POOL";
  randomizeGifts?: boolean;
}

export interface MatchingRule {
  field: "variant_title" | "sku";
  operator: "starts_with" | "ends_with" | "contains";
  value: string;
}

export interface CartLineSnapshot {
  key: string;
  variantId: string;
  productId: string;
  title?: string;
  variantTitle?: string;
  sku?: string;
  vendor?: string;
  productType?: string;
  tags?: string[];
  collectionIds?: string[];
  quantity: number;
  price: number;
  finalPrice?: number;
  properties?: Record<string, string | null>;
}

export interface CartSnapshot {
  token: string;
  subtotal: number;
  currency?: string;
  lines: CartLineSnapshot[];
  discountCodes?: string[];
  customer?: {
    id?: string;
    loggedIn: boolean;
    tags?: string[];
    orderCount?: number;
  };
  country?: string;
}

export interface CartMutation {
  type: "ADD" | "CHANGE";
  variantId?: string;
  lineKey?: string;
  quantity: number;
  properties?: Record<string, string>;
  // A silent mutation only updates hidden line-item properties without changing
  // what the shopper sees (e.g. tagging a mystery-box parent with its selection),
  // so the storefront can apply it without a visible cart reload.
  silent?: boolean;
}

export interface CartEvaluation {
  mutations: CartMutation[];
  messages: string[];
  matchedGiftRuleIds: string[];
  matchedMysteryBoxIds: string[];
  signature: string;
}
