use crate::schema;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use shopify_function::prelude::*;
use shopify_function::Result;

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 { return None; }
    (0..value.len()).step_by(2).map(|index| u8::from_str_radix(&value[index..index + 2], 16).ok()).collect()
}

fn valid_signature(secret: &str, payload: &str, signature: Option<&str>) -> bool {
    let Some(bytes) = signature.and_then(decode_hex) else { return false };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else { return false };
    mac.update(payload.as_bytes());
    mac.verify_slice(&bytes).is_ok()
}

fn numeric_id(value: &str) -> &str {
    value.rsplit('/').next().unwrap_or(value)
}

fn normalized(value: &str) -> String {
    value.trim().to_lowercase()
}

// Mirrors the TypeScript `compare()` used by the storefront/app-proxy engine
// (app/lib/promotion-engine.server.ts), so a condition re-checked here at
// checkout time agrees with how it was originally evaluated.
fn cmp(actual: &str, operator: &str, expected: &str) -> bool {
    let actual_num = actual.trim().parse::<f64>().ok();
    let expected_num = expected.trim().parse::<f64>().ok();
    let left = normalized(actual);
    let right = normalized(expected);
    match operator {
        "equals" => match (actual_num, expected_num) {
            (Some(a), Some(b)) => a == b,
            _ => left == right,
        },
        "not_equals" => match (actual_num, expected_num) {
            (Some(a), Some(b)) => a != b,
            _ => left != right,
        },
        "greater_than" => matches!((actual_num, expected_num), (Some(a), Some(b)) if a > b),
        "greater_or_equal" => matches!((actual_num, expected_num), (Some(a), Some(b)) if a >= b),
        "less_than" => matches!((actual_num, expected_num), (Some(a), Some(b)) if a < b),
        "less_or_equal" => matches!((actual_num, expected_num), (Some(a), Some(b)) if a <= b),
        "contains" => left.contains(&right),
        "not_contains" => !left.contains(&right),
        "starts_with" => left.starts_with(&right),
        "ends_with" => left.ends_with(&right),
        _ => false,
    }
}

// A cart line that isn't itself a gift/reward line — i.e. something the
// shopper actually chose to buy, and so a valid candidate for satisfying a
// rule's trigger conditions. Matches the "purchasable" filter in the
// TypeScript engine.
struct PurchasableLine {
    product_id: String,
    variant_id: String,
    quantity: i32,
    amount_per_quantity: f64,
}

struct EvalContext {
    lines: Vec<PurchasableLine>,
    subtotal: f64,
    total_quantity: i32,
    distinct_products: usize,
}

// Only fields whose live value the Function's input query can cheaply fetch
// are re-checked here. Shopify caps a Function input query at a calculated
// cost of 30 (shopify.dev/docs/api/functions/latest#input-query-limits);
// tag/collection lookups and several other fields fall outside that budget,
// so rules using them are marked unverifiable by encodeConditionsForFunction()
// in the TS engine and skip this re-check, trusting the signature alone.
fn evaluate_condition(field: &str, operator: &str, values: &[&str], ctx: &EvalContext) -> bool {
    let first = values.first().copied().unwrap_or("");
    match field {
        "subtotal" => cmp(&format!("{}", ctx.subtotal), operator, first),
        "quantity" => cmp(&ctx.total_quantity.to_string(), operator, first),
        "distinct_products" => cmp(&ctx.distinct_products.to_string(), operator, first),
        "product" => ctx.lines.iter().any(|line| values.iter().any(|v| cmp(&line.product_id, operator, v))),
        "variant" => ctx.lines.iter().any(|line| values.iter().any(|v| cmp(&line.variant_id, operator, v))),
        // Any other field means something we can't verify slipped through
        // encoding — fail closed rather than silently granting the discount.
        _ => false,
    }
}

// Parses the "<matchMode>|<field>::<operator>::<value1>||<value2>~~..." blob
// produced by encodeConditionsForFunction() in the TS engine and re-evaluates
// it against the live cart at checkout time.
fn conditions_satisfied(blob: &str, ctx: &EvalContext) -> bool {
    let Some((match_mode, rest)) = blob.split_once('|') else { return true };
    if rest.is_empty() {
        return true;
    }
    let mut matched_any = false;
    let mut matched_all = true;
    for record in rest.split("~~") {
        let mut parts = record.splitn(3, "::");
        let field = parts.next().unwrap_or("");
        let operator = parts.next().unwrap_or("");
        let values_str = parts.next().unwrap_or("");
        let values: Vec<&str> = values_str.split("||").collect();
        let result = evaluate_condition(field, operator, &values, ctx);
        matched_any = matched_any || result;
        matched_all = matched_all && result;
    }
    if match_mode == "ANY" { matched_any } else { matched_all }
}

// Whether the required trigger product/variant is still present in the cart
// with enough quantity — used to re-check a free gift or mystery box reward
// wasn't earned by a product that has since been removed from the cart.
fn trigger_present(ctx: &EvalContext, product_id: &str, variant_id: &str, min_qty: i32) -> bool {
    let total: i32 = ctx
        .lines
        .iter()
        .filter(|line| line.product_id == product_id || (!variant_id.is_empty() && line.variant_id == variant_id))
        .map(|line| line.quantity)
        .sum();
    total >= min_qty.max(1)
}

fn percentage_candidate(line_id: String, quantity: i32, value: f64, message: &str) -> schema::ProductDiscountCandidate {
    schema::ProductDiscountCandidate {
        targets: vec![schema::ProductDiscountCandidateTarget::CartLine(schema::CartLineTarget {
            id: line_id,
            quantity: Some(quantity),
        })],
        message: Some(message.to_string()),
        value: schema::ProductDiscountCandidateValue::Percentage(schema::Percentage {
            value: Decimal(value),
        }),
        associated_discount_code: None,
        prerequisites: None,
    }
}

fn fixed_candidate(line_id: String, quantity: i32, value: f64, message: &str) -> schema::ProductDiscountCandidate {
    schema::ProductDiscountCandidate {
        targets: vec![schema::ProductDiscountCandidateTarget::CartLine(schema::CartLineTarget {
            id: line_id,
            quantity: Some(quantity),
        })],
        message: Some(message.to_string()),
        value: schema::ProductDiscountCandidateValue::FixedAmount(
            schema::ProductDiscountCandidateFixedAmount {
                amount: Decimal(value),
                applies_to_each_item: Some(true),
            },
        ),
        associated_discount_code: None,
        prerequisites: None,
    }
}

#[shopify_function]
fn cart_lines_discounts_generate_run(
    input: schema::cart_lines_discounts_generate_run::Input,
) -> Result<schema::CartLinesDiscountsGenerateRunResult> {
    if !input.discount().discount_classes().contains(&schema::DiscountClass::Product) {
        return Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] });
    }
    let Some(secret) = input.discount().signature_config().map(|config| config.value().as_str()) else {
        return Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] });
    };

    // Build the "what did the shopper actually keep in their cart" snapshot
    // once, up front, excluding gift/reward lines themselves — the same
    // "purchasable" filter the TS engine uses when it first evaluated the
    // rule. This is what a bypass attempt (remove the trigger, keep the
    // gift, jump straight to checkout) has to still satisfy.
    let mut purchasable_lines = Vec::new();
    for line in input.cart().lines() {
        let variant = match line.merchandise() {
            schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise::ProductVariant(value) => value,
            _ => continue,
        };
        let is_free_gift = line.free_gift_rule().and_then(|value| value.value()).is_some();
        let is_mystery_reward = line.mystery_reward().and_then(|value| value.value()).map(String::as_str) == Some("true");
        if is_free_gift || is_mystery_reward {
            continue;
        }
        purchasable_lines.push(PurchasableLine {
            product_id: numeric_id(variant.product().id()).to_string(),
            variant_id: numeric_id(variant.id()).to_string(),
            quantity: *line.quantity(),
            amount_per_quantity: line.cost().amount_per_quantity().amount().as_f64(),
        });
    }
    let subtotal: f64 = purchasable_lines
        .iter()
        .map(|line| line.amount_per_quantity * f64::from(line.quantity))
        .sum();
    let total_quantity: i32 = purchasable_lines.iter().map(|line| line.quantity).sum();
    let distinct_products = purchasable_lines
        .iter()
        .map(|line| line.product_id.clone())
        .collect::<std::collections::HashSet<_>>()
        .len();

    let ctx = EvalContext {
        lines: purchasable_lines,
        subtotal,
        total_quantity,
        distinct_products,
    };

    let mut candidates = Vec::new();
    for line in input.cart().lines() {
        let variant = match line.merchandise() {
            schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise::ProductVariant(value) => value,
            _ => continue,
        };
        let variant_id = numeric_id(variant.id());
        let free_gift = line.free_gift_rule().and_then(|value| value.value()).map(String::as_str);
        let free_gift_name = line.free_gift_name().and_then(|value| value.value()).map(String::as_str);
        let mystery_reward = line.mystery_reward().and_then(|value| value.value()).map(String::as_str);
        let mystery_reward_name = line.mystery_reward_name().and_then(|value| value.value()).map(String::as_str);
        let promotion_kind = line.promotion_kind().and_then(|value| value.value()).map(String::as_str).unwrap_or("");
        let mystery_box = line.mystery_box_id().and_then(|value| value.value()).map(String::as_str);
        let signature = line.promotion_signature().and_then(|value| value.value()).map(String::as_str);

        // Process Free Gift promotions
        if let Some(free_gift_id) = free_gift {
            let discount_type = line.free_gift_discount_type().and_then(|value| value.value()).map(String::as_str).unwrap_or("FREE");
            let discount_value_str = line.free_gift_discount_value().and_then(|value| value.value()).map(String::as_str).unwrap_or("100.0");
            let discount_value = discount_value_str.parse::<f64>().unwrap_or(100.0);
            let unverifiable = line.free_gift_unverifiable().and_then(|value| value.value()).map(String::as_str) == Some("true");
            let conditions_blob = line.free_gift_conditions().and_then(|value| value.value()).map(String::as_str);
            // The awarded quantity is part of the signed payload. Using the raw
            // property string (not a reparsed number) keeps the reconstructed
            // payload byte-identical to what the engine signed.
            let awarded_qty_str = line.free_gift_qty().and_then(|value| value.value()).map(String::as_str).unwrap_or("1");
            let awarded_qty = awarded_qty_str.parse::<i32>().unwrap_or(1).max(1);

            // Signed payload: variantId|free_gift_discount|ruleId|type|value|qty|conditions
            let conditions_component = if unverifiable { "UNVERIFIABLE" } else { conditions_blob.unwrap_or("") };
            let payload = format!("{variant_id}|free_gift_discount|{free_gift_id}|{discount_type}|{discount_value_str}|{awarded_qty_str}|{conditions_component}");

            if valid_signature(secret, &payload, signature) {
                // Re-check the rule's trigger conditions against the *current*
                // cart, independent of the signature: a shopper who removed the
                // triggering product and jumped straight to checkout (skipping
                // the storefront JS that would otherwise remove the gift)
                // shouldn't still get the discount. Lines whose conditions use
                // a field this Function can't verify (tags/collections) are
                // left as-is, trusting the signature alone like before.
                let conditions_ok = unverifiable
                    || conditions_blob.map(|blob| conditions_satisfied(blob, &ctx)).unwrap_or(true);
                if !conditions_ok {
                    continue;
                }
                // Only discount the awarded number of units. If the shopper
                // inflated the gift line's quantity via the cart AJAX API, the
                // extra units above the signed quantity are charged in full.
                let target_qty = awarded_qty.min(*line.quantity());
                let message = free_gift_name.unwrap_or("Free gift");
                match discount_type {
                    "PERCENT_OFF" => {
                        candidates.push(percentage_candidate(line.id().to_string(), target_qty, discount_value.min(100.0), message));
                    }
                    "FIXED_OFF" => {
                        candidates.push(fixed_candidate(line.id().to_string(), target_qty, discount_value, message));
                    }
                    _ => {
                        candidates.push(percentage_candidate(line.id().to_string(), target_qty, 100.0, message));
                    }
                }
                continue;
            }
        }

        // Process Mystery Box rewards
        if mystery_reward == Some("true") {
            let promotion_id = mystery_box.unwrap_or("");
            let trigger_product_id = line.mystery_trigger_product_id().and_then(|value| value.value()).map(String::as_str);
            let trigger_variant_id = line.mystery_trigger_variant_id().and_then(|value| value.value()).map(String::as_str).unwrap_or("");
            let trigger_min_qty = line
                .mystery_trigger_min_qty()
                .and_then(|value| value.value())
                .and_then(|value| value.parse::<i32>().ok())
                .unwrap_or(1);
            // Kind is hard-coded to match exactly what the engine signs
            // (promotion-engine.server.ts signs "mystery_box_bonus", while the
            // line's _promotion_kind property is "mystery_box"); reconstructing
            // from the property would never verify.
            let payload = format!(
                "{variant_id}|mystery_box_bonus|{promotion_id}|{}|{trigger_variant_id}|{trigger_min_qty}",
                trigger_product_id.unwrap_or(""),
            );
            let _ = promotion_kind;
            if valid_signature(secret, &payload, signature) {
                let trigger_ok = trigger_product_id
                    .map(|product_id| trigger_present(&ctx, product_id, trigger_variant_id, trigger_min_qty))
                    .unwrap_or(true);
                if !trigger_ok {
                    continue;
                }
                let message = mystery_reward_name.unwrap_or("Included with Mystery Box");
                candidates.push(percentage_candidate(line.id().to_string(), *line.quantity(), 100.0, message));
                continue;
            }
        }

        if line.pricing_box().and_then(|value| value.value()).is_none() {
            continue;
        }
        let price_type = line.price_type().and_then(|value| value.value()).map(String::as_str).unwrap_or("");
        // Keep the raw property string for the signed payload (so it stays
        // byte-identical to what the engine signed via String(tier.value)),
        // and parse a separate f64 only for the discount arithmetic.
        let configured_str = line.price_value().and_then(|value| value.value()).map(String::as_str).unwrap_or("");
        let Some(configured) = configured_str.parse::<f64>().ok().filter(|value| *value >= 0.0) else { continue };
        let pricing_box = line.pricing_box().and_then(|value| value.value()).map(String::as_str).unwrap_or("");
        let trigger_product_id = line.mystery_trigger_product_id().and_then(|value| value.value()).map(String::as_str);
        let trigger_variant_id = line.mystery_trigger_variant_id().and_then(|value| value.value()).map(String::as_str).unwrap_or("");
        let price_payload = format!(
            "{variant_id}|price|{pricing_box}|{price_type}|{configured_str}|{}|{trigger_variant_id}",
            trigger_product_id.unwrap_or(""),
        );
        if !valid_signature(secret, &price_payload, signature) {
            continue;
        }
        // The quantity-tier discount only holds while the triggering parent
        // product is still in the cart, re-checked independently of the sig.
        {
            let trigger_ok = trigger_product_id
                .map(|product_id| trigger_present(&ctx, product_id, trigger_variant_id, 1))
                .unwrap_or(true);
            if !trigger_ok {
                continue;
            }
        }
        match price_type {
            "PERCENT_OFF" => candidates.push(percentage_candidate(line.id().to_string(), *line.quantity(), configured.min(100.0), "Mystery Box quantity price")),
            "FIXED_OFF" => candidates.push(fixed_candidate(line.id().to_string(), *line.quantity(), configured, "Mystery Box quantity price")),
            "FIXED_PRICE" => {
                let current = line.cost().amount_per_quantity().amount().as_f64();
                let reduction = (current - configured).max(0.0);
                if reduction > 0.0 { candidates.push(fixed_candidate(line.id().to_string(), *line.quantity(), reduction, "Mystery Box quantity price")); }
            }
            _ => {}
        }
    }

    if candidates.is_empty() {
        return Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] });
    }
    Ok(schema::CartLinesDiscountsGenerateRunResult {
        operations: vec![schema::CartOperation::ProductDiscountsAdd(
            schema::ProductDiscountsAddOperation {
                selection_strategy: schema::ProductDiscountSelectionStrategy::All,
                candidates,
            },
        )],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(product_id: &str, variant_id: &str, quantity: i32) -> PurchasableLine {
        PurchasableLine {
            product_id: product_id.to_string(),
            variant_id: variant_id.to_string(),
            quantity,
            amount_per_quantity: 10.0,
        }
    }

    fn ctx_with_lines(lines: Vec<PurchasableLine>) -> EvalContext {
        let total_quantity = lines.iter().map(|l| l.quantity).sum();
        let subtotal = lines.iter().map(|l| l.amount_per_quantity * f64::from(l.quantity)).sum();
        let distinct_products = lines
            .iter()
            .map(|l| l.product_id.clone())
            .collect::<std::collections::HashSet<_>>()
            .len();
        EvalContext {
            lines,
            subtotal,
            total_quantity,
            distinct_products,
        }
    }

    #[test]
    fn accepts_a_valid_hmac_and_rejects_tampering() {
        let signature = "61592e3f1951b10c4bb87361ca0d9a195c18d60d07e71a71ba621b3fa05de5de";
        assert!(valid_signature("fixture-secret", "111|free_gift|rule-1", Some(signature)));
        assert!(!valid_signature("fixture-secret", "999|free_gift|rule-1", Some(signature)));
        assert!(!valid_signature("wrong-secret", "111|free_gift|rule-1", Some(signature)));
    }

    #[test]
    fn rejects_missing_or_malformed_signatures() {
        assert!(!valid_signature("fixture-secret", "payload", None));
        assert!(!valid_signature("fixture-secret", "payload", Some("not-hex")));
    }

    fn sign(secret: &str, payload: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(payload.as_bytes());
        mac.finalize().into_bytes().iter().map(|b| format!("{:02x}", b)).collect()
    }

    #[test]
    fn free_gift_signature_binds_awarded_quantity() {
        // A signature earned for quantity 1 must not verify against a payload
        // claiming quantity 5 — so a shopper who inflates the gift line's
        // quantity can't have the extra units discounted.
        let secret = "fixture-secret";
        let signed_for_one =
            sign(secret, "111|free_gift_discount|rule-1|FREE|100|1|ALL|");
        assert!(valid_signature(
            secret,
            "111|free_gift_discount|rule-1|FREE|100|1|ALL|",
            Some(&signed_for_one),
        ));
        assert!(!valid_signature(
            secret,
            "111|free_gift_discount|rule-1|FREE|100|5|ALL|",
            Some(&signed_for_one),
        ));
    }

    #[test]
    fn denies_free_gift_when_trigger_product_removed_from_cart() {
        // The exact reported exploit: cart no longer has the triggering
        // product, so re-checking the "product equals 111" condition must fail.
        let ctx = ctx_with_lines(vec![line("222", "333", 1)]);
        assert!(!conditions_satisfied("ALL|product::equals::111", &ctx));
    }

    #[test]
    fn allows_free_gift_when_trigger_product_still_present() {
        let ctx = ctx_with_lines(vec![line("111", "444", 2)]);
        assert!(conditions_satisfied("ALL|product::equals::111", &ctx));
    }

    #[test]
    fn evaluates_subtotal_and_quantity_conditions() {
        let ctx = ctx_with_lines(vec![line("111", "444", 5)]);
        assert!(conditions_satisfied("ALL|subtotal::greater_or_equal::40", &ctx));
        assert!(!conditions_satisfied("ALL|subtotal::greater_or_equal::100", &ctx));
        assert!(conditions_satisfied("ALL|quantity::greater_or_equal::5", &ctx));
        assert!(!conditions_satisfied("ALL|quantity::greater_or_equal::6", &ctx));
    }

    #[test]
    fn any_match_mode_passes_if_one_condition_holds() {
        let ctx = ctx_with_lines(vec![line("111", "444", 1)]);
        assert!(conditions_satisfied("ANY|product::equals::999~~product::equals::111", &ctx));
        assert!(!conditions_satisfied("ANY|product::equals::999~~product::equals::888", &ctx));
    }

    #[test]
    fn empty_conditions_are_vacuously_true() {
        let ctx = ctx_with_lines(vec![]);
        assert!(conditions_satisfied("ALL|", &ctx));
        assert!(conditions_satisfied("ANY|", &ctx));
    }

    #[test]
    fn trigger_present_checks_quantity_threshold() {
        let ctx = ctx_with_lines(vec![line("111", "444", 1)]);
        assert!(trigger_present(&ctx, "111", "", 1));
        assert!(!trigger_present(&ctx, "111", "", 2));
        assert!(!trigger_present(&ctx, "999", "", 1));
    }

    #[test]
    fn trigger_present_is_false_once_product_removed() {
        let ctx = ctx_with_lines(vec![]);
        assert!(!trigger_present(&ctx, "111", "", 1));
    }
}
