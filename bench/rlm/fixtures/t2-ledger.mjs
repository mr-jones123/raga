/**
 * T2 fixture: a small stdlib-only Python package `ledger` with a pytest suite.
 *
 * The task renames `apply_tax` to `add_sales_tax` and adds a keyword-only `rounding` parameter that every
 * direct and indirect caller must accept and forward. The seed picks the catalog, rates, and test data.
 * Expected numbers in the tests come from `taxCents` below, an exact integer reimplementation of the
 * Python rounding, so the visible suite pins today's behavior and the hidden suite pins the new API.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRng } from "./prng.mjs";

export const OLD_NAME = "apply_tax";
export const NEW_NAME = "add_sales_tax";
const MODES = ["half_even", "half_up", "down"];

/** Tax in cents on `amount` at the decimal-string `rate`, rounded like Python's Decimal quantize. */
function taxCents(amount, rate, mode) {
	const [whole, frac = ""] = rate.split(".");
	const den = 10n ** BigInt(frac.length);
	const num = BigInt(whole + frac);
	const product = BigInt(amount) * num;
	const q = product / den;
	const r2 = (product % den) * 2n;
	let result = q;
	if (mode === "half_up" && r2 >= den) result = q + 1n;
	if (mode === "half_even" && (r2 > den || (r2 === den && q % 2n === 1n))) result = q + 1n;
	return Number(result);
}

const withTax = (amount, rate, mode) => amount + taxCents(amount, rate, mode);

function buildModel(rng) {
	const names = rng.shuffle([
		["MUG", "Enamel mug"],
		["LAMP", "Desk lamp"],
		["PEN", "Fountain pen"],
		["BAG", "Canvas bag"],
		["BOOK", "Field notebook"],
		["TEA", "Loose leaf tea"],
		["CLIP", "Binder clips"],
		["CABLE", "USB cable"],
	]);
	const products = names.slice(0, 6).map(([sku, name], i) => ({
		sku,
		name,
		price: rng.int(10, 400) * 10 + (rng.chance(0.3) ? 5 : 0),
		taxable: i !== 5 && !(i === 4 && rng.chance(0.5)),
	}));
	return {
		products,
		shippingRate: rng.pick(["0.05", "0.1"]),
		baseCents: rng.pick([430, 450, 470, 490]),
		per100g: rng.pick([30, 50, 70]),
	};
}

function cartTotals(model, rate, lines, mode) {
	let subtotal = 0;
	let taxable = 0;
	for (const [sku, qty] of lines) {
		const product = model.products.find((p) => p.sku === sku);
		subtotal += product.price * qty;
		if (product.taxable) taxable += product.price * qty;
	}
	const tax = taxCents(taxable, rate, mode);
	return { subtotal, taxable, tax, total: subtotal + tax };
}

function shippingCost(model, weight, express, mode) {
	let base = model.baseCents + Math.floor(weight / 100) * model.per100g;
	if (express) base *= 2;
	return withTax(base, model.shippingRate, mode);
}

function randomCart(rng, model) {
	const lines = [];
	for (const product of rng.shuffle(model.products).slice(0, rng.int(1, 4))) lines.push([product.sku, rng.int(1, 3)]);
	return { rate: rng.pick(["0.05", "0.0825", "0.07", "0.2"]), lines };
}

/** A cart whose total differs between rounding modes, so the hidden tests notice a dropped `rounding`. */
function sensitiveCart(rng, model, differs) {
	for (let i = 0; i < 5000; i++) {
		const cart = randomCart(rng, model);
		if (differs(cart)) return cart;
	}
	throw new Error("could not find a rounding-sensitive cart; change the seed");
}

const differsUp = (model) => (cart) =>
	cartTotals(model, cart.rate, cart.lines, "half_up").total !== cartTotals(model, cart.rate, cart.lines, "half_even").total;
const differsDown = (model) => (cart) =>
	cartTotals(model, cart.rate, cart.lines, "down").total !== cartTotals(model, cart.rate, cart.lines, "half_even").total;

const pyCart = (cart) =>
	`Cart(${cart.rate})${cart.lines.map(([sku, qty]) => `.add(${JSON.stringify(sku)}, ${qty})`).join("")}`;

function sources(model) {
	const catalog = model.products
		.map((p) => `    "${p.sku}": {"name": "${p.name}", "price": ${p.price}, "taxable": ${p.taxable ? "True" : "False"}},`)
		.join("\n");
	return {
		"README.md": `# ledger

A tiny order and invoicing library. All amounts are integer cents. Run the tests with \`python -m pytest -q\`.
`,
		"ledger/__init__.py": `"""ledger: a tiny order and invoicing library. All amounts are integer cents."""
from ledger.tax import apply_tax, tax_only
from ledger.cart import Cart

__all__ = ["apply_tax", "tax_only", "Cart"]
`,
		"ledger/money.py": `"""Parsing and formatting of integer cent amounts."""
from decimal import ROUND_HALF_EVEN, Decimal


def to_cents(text: str) -> int:
    """Parse a decimal string such as "12.34" into cents."""
    return int((Decimal(text) * 100).quantize(Decimal(1), rounding=ROUND_HALF_EVEN))


def format_cents(cents: int, currency: str = "USD") -> str:
    """Format cents as "USD 12.34"."""
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{currency} {cents // 100}.{cents % 100:02d}"
`,
		"ledger/tax.py": `"""Sales tax. Rates are fractions, e.g. 0.0825 for 8.25%."""
from decimal import ROUND_HALF_EVEN, Decimal


def apply_tax(amount_cents: int, rate: float) -> int:
    """Return amount_cents plus sales tax at rate, with the tax rounded to whole cents, half to even."""
    if amount_cents < 0:
        raise ValueError("amount_cents must not be negative")
    tax = (Decimal(amount_cents) * Decimal(str(rate))).quantize(Decimal(1), rounding=ROUND_HALF_EVEN)
    return amount_cents + int(tax)


def tax_only(amount_cents: int, rate: float) -> int:
    """Return just the tax that apply_tax adds to amount_cents."""
    return apply_tax(amount_cents, rate) - amount_cents
`,
		"ledger/catalog.py": `"""The product catalog."""

PRODUCTS = {
${catalog}
}


def price_of(sku: str) -> int:
    try:
        return PRODUCTS[sku]["price"]
    except KeyError:
        raise KeyError(f"unknown sku {sku!r}") from None


def is_taxable(sku: str) -> bool:
    return PRODUCTS[sku]["taxable"]
`,
		"ledger/cart.py": `"""A shopping cart."""
from ledger.catalog import is_taxable, price_of
from ledger.tax import apply_tax


class Cart:
    def __init__(self, tax_rate: float):
        self.tax_rate = tax_rate
        self.lines: list[tuple[str, int]] = []

    def add(self, sku: str, qty: int = 1) -> "Cart":
        if qty <= 0:
            raise ValueError("qty must be positive")
        price_of(sku)
        self.lines.append((sku, qty))
        return self

    def subtotal(self) -> int:
        return sum(price_of(sku) * qty for sku, qty in self.lines)

    def taxable_subtotal(self) -> int:
        return sum(price_of(sku) * qty for sku, qty in self.lines if is_taxable(sku))

    def total(self) -> int:
        """Subtotal plus tax on the taxable lines (see apply_tax)."""
        exempt = self.subtotal() - self.taxable_subtotal()
        return apply_tax(self.taxable_subtotal(), self.tax_rate) + exempt
`,
		"ledger/invoice.py": `"""Invoices for carts."""
from ledger import tax
from ledger.cart import Cart
from ledger.catalog import PRODUCTS, price_of
from ledger.money import format_cents


def build_invoice(cart: Cart, customer: str) -> dict:
    lines = [
        {"sku": sku, "name": PRODUCTS[sku]["name"], "qty": qty, "amount": price_of(sku) * qty}
        for sku, qty in cart.lines
    ]
    return {
        "customer": customer,
        "lines": lines,
        "subtotal": cart.subtotal(),
        "tax": tax.tax_only(cart.taxable_subtotal(), cart.tax_rate),
        "total": cart.total(),
    }


def render_invoice(cart: Cart, customer: str) -> str:
    invoice = build_invoice(cart, customer)
    rows = [f"Invoice for {customer}"]
    for line in invoice["lines"]:
        rows.append(f"{line['qty']} x {line['name']}: {format_cents(line['amount'])}")
    rows.append(f"Subtotal: {format_cents(invoice['subtotal'])}")
    rows.append(f"Tax: {format_cents(invoice['tax'])}")
    rows.append(f"Total: {format_cents(invoice['total'])}")
    return "\\n".join(rows)
`,
		"ledger/shipping.py": `"""Shipping costs. Shipping is taxed at a flat rate through apply_tax."""
from ledger.tax import apply_tax as taxed

SHIPPING_TAX_RATE = ${model.shippingRate}
BASE_CENTS = ${model.baseCents}
PER_100G_CENTS = ${model.per100g}


def shipping_cost(weight_grams: int, express: bool = False) -> int:
    base = BASE_CENTS + (weight_grams // 100) * PER_100G_CENTS
    if express:
        base *= 2
    return taxed(base, SHIPPING_TAX_RATE)
`,
		"ledger/refunds.py": `"""Refunds for returned items."""
import ledger.tax as t


def refund_amount(net_cents: int, returned_qty: int, ordered_qty: int, rate: float) -> int:
    """Refund the returned share of net_cents plus the tax charged on it."""
    if not 0 < returned_qty <= ordered_qty:
        raise ValueError("returned_qty must be between 1 and ordered_qty")
    portion = net_cents * returned_qty // ordered_qty
    return t.apply_tax(portion, rate)
`,
		"ledger/reports.py": `"""Daily sales reports."""
from ledger.invoice import build_invoice
from ledger.shipping import shipping_cost


def daily_report(orders: list) -> dict:
    """orders is a list of (cart, customer, weight_grams, express) tuples."""
    revenue = 0
    tax_total = 0
    shipping_total = 0
    for cart, customer, weight_grams, express in orders:
        invoice = build_invoice(cart, customer)
        shipping = shipping_cost(weight_grams, express)
        revenue += invoice["total"] + shipping
        tax_total += invoice["tax"]
        shipping_total += shipping
    return {"orders": len(orders), "revenue": revenue, "tax": tax_total, "shipping": shipping_total}
`,
	};
}

function formatCents(cents) {
	return `USD ${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function testData(rng, model) {
	const taxCases = [];
	for (let i = 0; i < 6; i++) {
		taxCases.push([rng.int(1, 2000) * 10 + rng.pick([0, 5]), rng.pick(["0.05", "0.0825", "0.07", "0.2"])]);
	}
	// Exact ties at 5%: 250 -> 12.5, 1030 -> 51.5, 50 -> 2.5.
	taxCases.push([250, "0.05"], [1030, "0.05"], [50, "0.05"], [0, "0.2"]);
	const carts = [
		sensitiveCart(rng, model, differsUp(model)),
		sensitiveCart(rng, model, differsDown(model)),
		randomCart(rng, model),
	];
	const shipments = [
		[rng.int(0, 30) * 100 + rng.int(0, 99), false],
		[rng.int(0, 30) * 100, true],
		[0, false],
	];
	const refunds = [];
	for (let i = 0; i < 3; i++) {
		const ordered = rng.int(2, 5);
		refunds.push([rng.int(10, 500) * 10 + rng.int(0, 9), rng.int(1, ordered), ordered, rng.pick(["0.05", "0.0825"])]);
	}
	refunds.push([2060, 1, 2, "0.05"]); // 1030 * 0.05 = 51.5, a tie
	return { taxCases, carts, shipments, refunds };
}

function refundCents(net, returned, ordered, rate, mode) {
	return withTax(Math.floor((net * returned) / ordered), rate, mode);
}

function visibleTests(model, data) {
	const m = "half_even";
	const taxRows = data.taxCases.map(([a, r]) => `    (${a}, ${r}, ${withTax(a, r, m)}),`).join("\n");
	const cartRows = data.carts
		.map((c) => {
			const t = cartTotals(model, c.rate, c.lines, m);
			return `    (lambda: ${pyCart(c)}, ${t.subtotal}, ${t.taxable}, ${t.total}),`;
		})
		.join("\n");
	const invoiceCart = data.carts[0];
	const inv = cartTotals(model, invoiceCart.rate, invoiceCart.lines, m);
	const shipRows = data.shipments
		.map(([w, e]) => `    (${w}, ${e ? "True" : "False"}, ${shippingCost(model, w, e, m)}),`)
		.join("\n");
	const refundRows = data.refunds
		.map(([n, r, o, rate]) => `    (${n}, ${r}, ${o}, ${rate}, ${refundCents(n, r, o, rate, m)}),`)
		.join("\n");
	const orders = data.carts.map((c, i) => [c, `cust${i}`, data.shipments[i][0], data.shipments[i][1]]);
	let revenue = 0;
	let taxTotal = 0;
	let shipTotal = 0;
	for (const [c, , w, e] of orders) {
		const t = cartTotals(model, c.rate, c.lines, m);
		const s = shippingCost(model, w, e, m);
		revenue += t.total + s;
		taxTotal += t.tax;
		shipTotal += s;
	}
	const pyOrders = orders.map(([c, name, w, e]) => `(${pyCart(c)}, "${name}", ${w}, ${e ? "True" : "False"})`).join(", ");
	return {
		"tests/test_money.py": `from ledger.money import format_cents, to_cents


def test_to_cents():
    assert to_cents("12.34") == 1234
    assert to_cents("0.005") == 0
    assert to_cents("7") == 700


def test_format_cents():
    assert format_cents(1234) == "USD 12.34"
    assert format_cents(5, "EUR") == "EUR 0.05"
    assert format_cents(-250) == "-USD 2.50"
`,
		"tests/test_tax.py": `import pytest

from ledger import apply_tax
from ledger.tax import tax_only

CASES = [
${taxRows}
]


@pytest.mark.parametrize("amount,rate,expected", CASES)
def test_apply_tax(amount, rate, expected):
    assert apply_tax(amount, rate) == expected


@pytest.mark.parametrize("amount,rate,expected", CASES)
def test_tax_only(amount, rate, expected):
    assert tax_only(amount, rate) == expected - amount


def test_negative_amount():
    with pytest.raises(ValueError):
        apply_tax(-1, 0.05)
`,
		"tests/test_cart.py": `import pytest

from ledger.cart import Cart

CASES = [
${cartRows}
]


@pytest.mark.parametrize("make,subtotal,taxable,total", CASES)
def test_cart_totals(make, subtotal, taxable, total):
    cart = make()
    assert cart.subtotal() == subtotal
    assert cart.taxable_subtotal() == taxable
    assert cart.total() == total


def test_rejects_bad_qty():
    with pytest.raises(ValueError):
        Cart(0.05).add("${model.products[0].sku}", 0)


def test_rejects_unknown_sku():
    with pytest.raises(KeyError):
        Cart(0.05).add("NOPE")
`,
		"tests/test_invoice.py": `from ledger.cart import Cart
from ledger.invoice import build_invoice, render_invoice


def make_cart():
    return ${pyCart(invoiceCart)}


def test_build_invoice():
    invoice = build_invoice(make_cart(), "ada")
    assert invoice["customer"] == "ada"
    assert invoice["subtotal"] == ${inv.subtotal}
    assert invoice["tax"] == ${inv.tax}
    assert invoice["total"] == ${inv.total}
    assert len(invoice["lines"]) == ${invoiceCart.lines.length}


def test_render_invoice():
    text = render_invoice(make_cart(), "ada")
    assert text.startswith("Invoice for ada")
    assert text.endswith("Total: ${formatCents(inv.total)}")
`,
		"tests/test_shipping.py": `import pytest

from ledger.shipping import shipping_cost


@pytest.mark.parametrize("weight,express,expected", [
${shipRows}
])
def test_shipping_cost(weight, express, expected):
    assert shipping_cost(weight, express) == expected
`,
		"tests/test_refunds.py": `import pytest

from ledger.refunds import refund_amount


@pytest.mark.parametrize("net,returned,ordered,rate,expected", [
${refundRows}
])
def test_refund_amount(net, returned, ordered, rate, expected):
    assert refund_amount(net, returned, ordered, rate) == expected


def test_refund_rejects_bad_qty():
    with pytest.raises(ValueError):
        refund_amount(1000, 3, 2, 0.05)
`,
		"tests/test_reports.py": `from ledger.cart import Cart
from ledger.reports import daily_report


def test_daily_report():
    report = daily_report([${pyOrders}])
    assert report == {"orders": ${orders.length}, "revenue": ${revenue}, "tax": ${taxTotal}, "shipping": ${shipTotal}}


def test_empty_report():
    assert daily_report([]) == {"orders": 0, "revenue": 0, "tax": 0, "shipping": 0}
`,
	};
}

/** The hidden suite the scorer copies in after the run. It pins the new name and the threaded parameter. */
function hiddenTests(model, data) {
	const perMode = (fn) => Object.fromEntries(MODES.map((mode) => [mode, fn(mode)]));
	const dict = (obj) => `{${Object.entries(obj).map(([k, v]) => `"${k}": ${v}`).join(", ")}}`;
	const taxRows = data.taxCases.map(([a, r]) => `    (${a}, ${r}, ${dict(perMode((mode) => withTax(a, r, mode)))}),`).join("\n");
	const cartRows = data.carts
		.map((c) => `    (lambda: ${pyCart(c)}, ${dict(perMode((mode) => cartTotals(model, c.rate, c.lines, mode).total))}, ${dict(perMode((mode) => cartTotals(model, c.rate, c.lines, mode).tax))}),`)
		.join("\n");
	const shipRows = data.shipments
		.map(([w, e]) => `    (${w}, ${e ? "True" : "False"}, ${dict(perMode((mode) => shippingCost(model, w, e, mode)))}),`)
		.join("\n");
	const refundRows = data.refunds
		.map(([n, r, o, rate]) => `    (${n}, ${r}, ${o}, ${rate}, ${dict(perMode((mode) => refundCents(n, r, o, rate, mode)))}),`)
		.join("\n");
	const orders = data.carts.map((c, i) => [c, `cust${i}`, data.shipments[i][0], data.shipments[i][1]]);
	const report = perMode((mode) => {
		let revenue = 0;
		for (const [c, , w, e] of orders) revenue += cartTotals(model, c.rate, c.lines, mode).total + shippingCost(model, w, e, mode);
		return revenue;
	});
	const pyOrders = orders.map(([c, name, w, e]) => `(${pyCart(c)}, "${name}", ${w}, ${e ? "True" : "False"})`).join(", ");
	const invoiceCart = data.carts[0];
	return `import inspect

import pytest

import ledger
import ledger.tax
from ledger import ${NEW_NAME}
from ledger.cart import Cart
from ledger.invoice import build_invoice, render_invoice
from ledger.refunds import refund_amount
from ledger.reports import daily_report
from ledger.shipping import shipping_cost
from ledger.tax import tax_only

MODES = ${JSON.stringify(MODES)}


def test_old_name_is_gone():
    assert not hasattr(ledger.tax, "${OLD_NAME}")
    assert not hasattr(ledger, "${OLD_NAME}")
    assert "${OLD_NAME}" not in ledger.__all__
    assert "${NEW_NAME}" in ledger.__all__


@pytest.mark.parametrize("fn", [${NEW_NAME}, tax_only, Cart.total, build_invoice, render_invoice, shipping_cost, refund_amount, daily_report])
def test_rounding_is_keyword_only_with_default(fn):
    param = inspect.signature(fn).parameters["rounding"]
    assert param.kind is inspect.Parameter.KEYWORD_ONLY
    assert param.default == "half_even"


def test_unknown_rounding_raises():
    with pytest.raises(ValueError):
        ${NEW_NAME}(100, 0.05, rounding="banker")


TAX = [
${taxRows}
]


@pytest.mark.parametrize("amount,rate,expected", TAX)
@pytest.mark.parametrize("mode", MODES)
def test_add_sales_tax(amount, rate, expected, mode):
    assert ${NEW_NAME}(amount, rate, rounding=mode) == expected[mode]
    assert tax_only(amount, rate, rounding=mode) == expected[mode] - amount


def test_default_is_half_even():
    assert ${NEW_NAME}(250, 0.05) == 262


CARTS = [
${cartRows}
]


@pytest.mark.parametrize("make,totals,taxes", CARTS)
@pytest.mark.parametrize("mode", MODES)
def test_cart_and_invoice(make, totals, taxes, mode):
    cart = make()
    assert cart.total(rounding=mode) == totals[mode]
    invoice = build_invoice(cart, "ada", rounding=mode)
    assert invoice["total"] == totals[mode]
    assert invoice["tax"] == taxes[mode]


@pytest.mark.parametrize("mode", MODES)
def test_render_invoice(mode):
    cart = ${pyCart(invoiceCart)}
    total = build_invoice(cart, "ada", rounding=mode)["total"]
    assert render_invoice(cart, "ada", rounding=mode).endswith(f"Total: USD {total // 100}.{total % 100:02d}")


@pytest.mark.parametrize("weight,express,expected", [
${shipRows}
])
@pytest.mark.parametrize("mode", MODES)
def test_shipping_cost(weight, express, expected, mode):
    assert shipping_cost(weight, express, rounding=mode) == expected[mode]


@pytest.mark.parametrize("net,returned,ordered,rate,expected", [
${refundRows}
])
@pytest.mark.parametrize("mode", MODES)
def test_refund_amount(net, returned, ordered, rate, expected, mode):
    assert refund_amount(net, returned, ordered, rate, rounding=mode) == expected[mode]


@pytest.mark.parametrize("mode", MODES)
def test_daily_report(mode):
    expected = ${dict(report)}
    assert daily_report([${pyOrders}], rounding=mode)["revenue"] == expected[mode]
`;
}

function writeTree(dir, files) {
	for (const [rel, content] of Object.entries(files)) {
		const path = join(dir, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
}

/**
 * Writes the project into `dir` and the hidden suite into `hiddenDir/test_hidden.py`.
 * Returns facts the scorer needs.
 */
export function generateT2(dir, hiddenDir, seed) {
	const rng = createRng(seed);
	const model = buildModel(rng);
	const data = testData(rng, model);
	writeTree(dir, { ...sources(model), ...visibleTests(model, data) });
	writeTree(hiddenDir, { "test_hidden.py": hiddenTests(model, data) });
	return { oldName: OLD_NAME, newName: NEW_NAME, packageDir: "ledger", testsDir: "tests" };
}
