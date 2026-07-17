from flask import Flask, jsonify, render_template

import data_store

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def status():
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(debug=True, port=5002)
