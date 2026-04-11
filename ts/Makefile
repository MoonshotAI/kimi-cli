.PHONY: prepare build check typecheck lint lint-fix lint-pkg sherif fmt fmt-check test test-watch test-coverage clean changeset version publish release

## Setup

prepare:
	pnpm install

## Build

build:
	pnpm run build

## Quality

check:
	pnpm run check

typecheck:
	pnpm run typecheck

lint:
	pnpm run lint

lint-fix:
	pnpm run lint:fix

sherif:
	pnpm run sherif

lint-pkg:
	pnpm run lint:pkg

## Format

fmt:
	pnpm run fmt

fmt-check:
	pnpm run fmt:check

## Test

test:
	pnpm run test

test-watch:
	pnpm run test:watch

test-coverage:
	pnpm run test:coverage

## Clean

clean:
	pnpm run clean

## Release

changeset:
	pnpm run changeset

version:
	pnpm run version

publish:
	pnpm run publish

release: version publish
