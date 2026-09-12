.PHONY: crawl index serve eval adversarial test refresh cost

crawl:
	python3 -m app.crawler --seeds ../docs/corpus_sources.csv --output data/corpus.jsonl

index:
	python3 -m app.indexer --corpus data/corpus.jsonl --database data/index.sqlite3

serve:
	python3 -m app.server

eval:
	python3 -m app.evaluate

adversarial:
	python3 -m app.adversarial_eval

test:
	python3 -m unittest discover -s tests -v

refresh:
	python3 -m app.refresh --apply

cost:
	python3 -m app.render_cost
