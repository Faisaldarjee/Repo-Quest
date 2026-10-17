.PHONY: install test typecheck build run

install:
	npm ci

test:
	npm test

typecheck:
	npm run typecheck

build:
	npm run build

run:
	npm run start
