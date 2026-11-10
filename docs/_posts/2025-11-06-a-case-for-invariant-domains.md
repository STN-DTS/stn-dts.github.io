---
layout: post
title: "A Case for Invariant Domains"
date: 2025-11-06
author: Greg Baker
categories:
- software-engineering
- domain-driven-design
- ddd
---

For the last ten years or so I've watched (and, honestly, helped spread) a habit I don't like: anemic domain objects.
These are classes that look like domain models but don't do anything. They hold data and that's it. Because nothing stops
them from holding bad data, everyone who uses them ends up writing their own sanity checks, and those checks get
scattered all over the codebase.

In this post I want to argue for the opposite: rich domain models that protect their own rules. I'll lean on what Martin
Fowler, Microsoft, and Amazon have said and done along the way.

## What's wrong with anemic domain objects

An anemic domain object is usually what you get when someone takes "separation of concerns" a step too far. The data
lives in one class and the behavior lives somewhere else. The domain class ends up as a bag of getters and setters, and
all the business rules, validation, and calculations move into service classes that push that data around.

Martin Fowler called this out back in 2003 in his article "Anemic Domain Model". His point was that it works against
encapsulation, the basic object-oriented idea of keeping data and the code that changes it together. An anemic model is
really procedural code wearing an object costume. You pay the cost of building a domain model and get none of the
payoff.

In practice this causes a few problems.

Validation gets scattered. If the object doesn't enforce its own rules, every caller has to check things itself. Those
checks drift apart over time and become hard to maintain.

Objects can be in an invalid state. Nothing prevents a half-built or nonsensical object from existing, so calling code
always has to be on guard.

The code stops describing the business. The model doesn't capture what the domain actually means, so the code is harder
to read and reason about.

Services get bloated. All the domain logic piles up in services, which ties the business rules tightly to the
application flow.

## Putting the rules back in the object

A rich domain model puts the behavior inside the domain objects themselves. Those objects enforce *invariants*: rules
about their state that must always be true. If an object never lets itself break an invariant, it can never end up in
an invalid state.

Here's a simple `BankAccount`:

```java
public class BankAccount {

	private BigDecimal balance;
	private boolean frozen;

	public BankAccount(BigDecimal initialBalance) {
		if (initialBalance == null) {
			throw new IllegalArgumentException("Initial balance cannot be null");
		}

		if (initialBalance.compareTo(BigDecimal.ZERO) < 0) {
			throw new IllegalArgumentException("Initial balance cannot be negative");
		}

		this.balance = initialBalance;
		this.frozen = false;
	}

	public void deposit(BigDecimal amount) {
		if (amount == null) {
			throw new IllegalArgumentException("Deposit amount cannot be null");
		}

		if (amount.compareTo(BigDecimal.ZERO) <= 0) {
			throw new IllegalArgumentException("Deposit amount must be positive");
		}

		if (frozen) {
			throw new IllegalStateException("Cannot deposit to frozen account");
		}

		this.balance = this.balance.add(amount);
	}

	public void withdraw(BigDecimal amount) {
		if (amount == null) {
			throw new IllegalArgumentException("Withdrawal amount cannot be null");
		}

		if (amount.compareTo(BigDecimal.ZERO) <= 0) {
			throw new IllegalArgumentException("Withdrawal amount must be positive");
		}

		if (frozen) {
			throw new IllegalStateException("Cannot withdraw from frozen account");
		}

		if (this.balance.compareTo(amount) < 0) {
			throw new IllegalStateException("Insufficient funds");
		}

		this.balance = this.balance.subtract(amount);
	}

	public void freeze() {
		this.frozen = true;
	}

	public BigDecimal getBalance() {
		return balance;
	}

}
```

This class enforces a handful of rules:

- The balance can't be negative.
- The initial balance and any amount passed in can't be null.
- Deposits and withdrawals must be positive.
- You can't deposit to or withdraw from a frozen account.
- You can't withdraw more than the balance, so no overdrafts.

All of those rules live inside the class. There's no way to create an account in a bad state or change it into one. So
any code that gets a `BankAccount` can trust that it's valid without checking.

## Value objects

A good way to push invariants down even further is with *value objects*. A value object is a small, immutable type
that's defined by its value rather than by an identity, like an amount of money or an email address. Instead of passing
raw `BigDecimal` or `String` values into your entities, you wrap them in a type that checks its own rules.

For example, instead of passing a raw `BigDecimal` to `deposit`, we could use a `Money` value object:

```java
public record Money(BigDecimal amount) {
	public Money {
		if (amount == null || amount.compareTo(BigDecimal.ZERO) < 0) {
			throw new IllegalArgumentException("Money amount cannot be negative");
		}
	}

	public Money add(Money other) {
		return new Money(this.amount.add(other.amount));
	}
	// ... other operations
}
```

This makes `BankAccount` simpler. It no longer has to check for null or negative amounts itself, because a `Money` can't
be created with one.

## What others have said

This is a core idea in Domain-Driven Design (DDD), from Eric Evans' well-known book of the same name. Evans says the
domain model is the "heart of business software", and that it should carry real behavior and strict invariants.

Microsoft's .NET architecture guidance says the same thing. Its docs on DDD-oriented microservices warn against anemic
domain models and say domain entities should hold data *plus* behavior. Microsoft recommends Plain Old CLR Objects
(POCOs), which are plain classes with no dependency on frameworks or infrastructure, that still contain the domain
logic.

Amazon has used DDD for a long time to manage the complexity of its large microservice architecture. We can't see their
internal code, but their focus on bounded contexts (clear boundaries around each part of the domain) and on domain
expertise suggests they build rich domains that enforce their own business rules at the core.

## What you get out of it

Moving the rules into the domain pays off in a few ways.

Bad data stops spreading. If an invalid object can't exist, it can't leak into the rest of the system and cause bugs
somewhere far away.

Changes get easier. Business rules live in one obvious place and are written down clearly, so changing them is less
risky.

Testing gets simpler. You can test a domain object on its own, and the invariants tell you exactly what to test.

The code matches the business. When the code reads like the domain, it's easier for developers and domain experts to
talk about it.

Services get thinner. They coordinate work instead of holding business logic, which keeps the design more modular.

## The hard parts

Switching to rich domain models isn't free. If you're used to anemic models, it can take a while to get a feel for
where logic belongs.

### Persistence

The most common pushback is about Object-Relational Mappers (ORMs) like Hibernate or Entity Framework. ORMs load rows
from the database into objects, and many of them want a public no-argument constructor and public setters to do it.
That undercuts encapsulation, because now anyone can build an empty object or change its fields.

There are a few ways around this:

- Use private constructors. Most modern ORMs can work with private or protected constructors and set fields directly,
  so your public API stays clean.
- Add a mapping layer. Keep a separate "dumb" persistence object for the database and map it to and from your rich
  domain entity. This lets your domain logic change without being tied to your database schema.
- Use the Memento pattern. The object hands out a snapshot of its state for saving, without exposing any setters.

### Other things that help

- Start small. Add invariants to new classes, or to classes you're already refactoring.
- Use aggregate roots (a DDD idea: one entity that controls access to a group of related objects) to manage complex
  object graphs.
- Use domain events to announce state changes.
- Use property-based testing, which throws lots of generated inputs at your code, to check that invariants hold.

## Wrapping up

Anemic domain objects have given us fragile systems that are hard to maintain, with validation code spread everywhere.
If we build rich domain models with strong invariants instead, the code can actually describe the business while keeping
the data valid.

Fowler, Microsoft, and Amazon show this isn't just theory. It works at scale. As our systems keep getting more complex,
invariant domains give us more reliable, maintainable, and readable code. It's time to bring encapsulation back and let
our domain models do more than hold data.
