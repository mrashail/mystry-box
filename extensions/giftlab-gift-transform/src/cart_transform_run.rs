use super::schema;
use schema::cart_transform_run::cart_transform_run_input::cart::lines::Merchandise;
use schema::cart_transform_run::cart_transform_run_input::cart::Lines;
use serde::Deserialize;
use shopify_function::prelude::*;
use shopify_function::Result;

#[derive(Deserialize, Debug, Clone)]
struct RuleCondition {
    field: String,
    operator: String,
    value: String,
}

#[derive(Deserialize, Debug, Clone)]
struct GiftChoice {
    #[serde(rename = "variantId")]
    variant_id: String,
    quantity: i32,
    #[serde(rename = "discountType")]
    discount_type: Option<String>,
    #[serde(rename = "discountValue")]
    discount_value: Option<f64>,
}

#[derive(Deserialize, Debug, Clone)]
struct CustomerRestrictions {
    #[serde(rename = "allowedCustomerTags")]
    allowed_customer_tags: Option<Vec<String>>,
    #[serde(rename = "excludedCustomerTags")]
    excluded_customer_tags: Option<Vec<String>>,
}

#[derive(Deserialize, Debug, Clone)]
struct RuleConfig {
    id: String,
    name: String,
    #[serde(rename = "matchMode")]
    match_mode: String,
    conditions: Vec<RuleCondition>,
    gifts: Vec<GiftChoice>,
    #[serde(rename = "allowMultiple")]
    allow_multiple: Option<bool>,
    #[serde(rename = "maxGifts")]
    max_gifts: Option<i64>,
    stackable: Option<bool>,
    priority: Option<i64>,
    restrictions: Option<CustomerRestrictions>,
}

fn numeric_id(gid: &str) -> &str {
    gid.rsplit('/').next().unwrap_or(gid)
}

fn condition_matches(cond: &RuleCondition, subtotal: f64, lines: &[Lines]) -> bool {
    let target_num: f64 = cond.value.parse().unwrap_or(0.0);
    match cond.field.as_str() {
        "subtotal" => match cond.operator.as_str() {
            "greater_or_equal" => subtotal >= target_num,
            "greater" => subtotal > target_num,
            "less_or_equal" => subtotal <= target_num,
            "less" => subtotal < target_num,
            "equal" => (subtotal - target_num).abs() < 0.01,
            _ => true,
        },
        "quantity" => {
            let total_qty: i64 = lines
                .iter()
                .filter(|l| {
                    l.promotion_kind()
                        .and_then(|a| a.value())
                        .map(|s| s.as_str()) != Some("free_gift")
                })
                .map(|l| *l.quantity() as i64)
                .sum();
            let qty_f = total_qty as f64;
            match cond.operator.as_str() {
                "greater_or_equal" => qty_f >= target_num,
                "greater" => qty_f > target_num,
                "less_or_equal" => qty_f <= target_num,
                "less" => qty_f < target_num,
                "equal" => (qty_f - target_num).abs() < 0.01,
                _ => true,
            }
        }
        "product" => lines.iter().any(|l| match l.merchandise() {
            Merchandise::ProductVariant(v) => {
                numeric_id(v.product().id().as_str()) == numeric_id(&cond.value)
            }
            _ => false,
        }),
        "variant" => lines.iter().any(|l| match l.merchandise() {
            Merchandise::ProductVariant(v) => {
                numeric_id(v.id().as_str()) == numeric_id(&cond.value)
            }
            _ => false,
        }),
        "sku" => lines.iter().any(|l| match l.merchandise() {
            Merchandise::ProductVariant(v) => {
                v.sku().map(|s| s.as_str()) == Some(cond.value.as_str())
            }
            _ => false,
        }),
        _ => true,
    }
}

#[shopify_function]
fn cart_transform_run(
    input: schema::cart_transform_run::CartTransformRunInput,
) -> Result<schema::CartTransformRunResult> {
    let rules_json = input
        .cart_transform()
        .metafield()
        .map(|m| m.value().as_str())
        .unwrap_or("[]");

    let rules: Vec<RuleConfig> = serde_json::from_str(rules_json).unwrap_or_default();
    if rules.is_empty() {
        return Ok(schema::CartTransformRunResult { operations: vec![] });
    }

    let declined_str = input
        .cart()
        .attribute()
        .and_then(|a| a.value())
        .map(|s| s.as_str())
        .unwrap_or("");
    let declined_set: Vec<&str> = declined_str
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    // Calculate subtotal from non-gift cart lines
    let subtotal: f64 = input
        .cart()
        .lines()
        .iter()
        .filter(|l| {
            l.promotion_kind()
                .and_then(|a| a.value())
                .map(|s| s.as_str()) != Some("free_gift")
        })
        .map(|l| {
            l.cost()
                .subtotal_amount()
                .amount()
                .as_f64()
        })
        .sum();

    let mut operations = vec![];

    // Find the carrier line: the first non-gift cart line
    let carrier_line = input.cart().lines().iter().find(|l| {
        l.promotion_kind()
            .and_then(|a| a.value())
            .map(|s| s.as_str()) != Some("free_gift")
    });

    if let Some(carrier) = carrier_line {
        for rule in &rules {
            if declined_set.contains(&rule.id.as_str()) {
                continue;
            }

            // The storefront client adds the free gift as a REAL cart line (so
            // it shows in the theme cart drawer, which reads /cart.js — a layer
            // this Cart Transform never reaches). When that real line is
            // present, expanding here too would put the gift in the cart TWICE
            // at checkout. So skip any rule whose gift line the client already
            // added; this function then only acts as a no-JS safety net,
            // materialising the gift at checkout for shoppers whose browser
            // never ran the client add.
            let already_added = input.cart().lines().iter().any(|l| {
                l.free_gift_rule()
                    .and_then(|a| a.value())
                    .map(|s| s.as_str())
                    == Some(rule.id.as_str())
            });
            if already_added {
                continue;
            }

            let matches = if rule.conditions.is_empty() {
                true
            } else if rule.match_mode == "ANY" {
                rule.conditions
                    .iter()
                    .any(|c| condition_matches(c, subtotal, input.cart().lines()))
            } else {
                rule.conditions
                    .iter()
                    .all(|c| condition_matches(c, subtotal, input.cart().lines()))
            };

            if matches && !rule.gifts.is_empty() {
                let carrier_merchandise_id = match carrier.merchandise() {
                    Merchandise::ProductVariant(v) => v.id().to_string(),
                    _ => continue,
                };

                // Preserve the carrier's own per-unit price explicitly. When a
                // line is expanded, every component's price must be stated — a
                // component left with no price adjustment can be presented at
                // $0, which would make the shopper's actual product free. The
                // canonical Shopify bundle example sets the original item's
                // price for exactly this reason, so we mirror it here.
                let carrier_unit_price = carrier.cost().amount_per_quantity().amount().as_f64();

                let mut expanded_items = vec![
                    // 1. Original carrier item, kept at its real price.
                    schema::ExpandedItem {
                        merchandise_id: carrier_merchandise_id,
                        quantity: *carrier.quantity(),
                        price: Some(schema::ExpandedItemPriceAdjustment {
                            adjustment: schema::ExpandedItemPriceAdjustmentValue::FixedPricePerUnit(
                                schema::ExpandedItemFixedPricePerUnitAdjustment {
                                    amount: Decimal(carrier_unit_price),
                                },
                            ),
                        }),
                        attributes: Some(vec![]),
                    },
                ];

                // 2. Gift items
                for gift in &rule.gifts {
                    let gift_variant_gid = if gift.variant_id.starts_with("gid://") {
                        gift.variant_id.clone()
                    } else {
                        format!("gid://shopify/ProductVariant/{}", gift.variant_id)
                    };

                    expanded_items.push(schema::ExpandedItem {
                        merchandise_id: gift_variant_gid,
                        quantity: gift.quantity,
                        price: Some(schema::ExpandedItemPriceAdjustment {
                            adjustment: schema::ExpandedItemPriceAdjustmentValue::FixedPricePerUnit(
                                schema::ExpandedItemFixedPricePerUnitAdjustment {
                                    amount: Decimal(0.0),
                                },
                            ),
                        }),
                        attributes: Some(vec![
                            schema::AttributeOutput {
                                key: "_free_gift_rule".to_string(),
                                value: rule.id.clone(),
                            },
                            schema::AttributeOutput {
                                key: "_promotion_kind".to_string(),
                                value: "free_gift".to_string(),
                            },
                        ]),
                    });
                }

                operations.push(schema::Operation::LineExpand(schema::LineExpandOperation {
                    cart_line_id: carrier.id().to_string(),
                    expanded_cart_items: expanded_items,
                    image: None,
                    price: None,
                    title: None,
                }));

                if !rule.stackable.unwrap_or(false) {
                    break;
                }
            }
        }
    }

    Ok(schema::CartTransformRunResult { operations })
}
