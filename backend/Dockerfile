# Use the official Python image as a base
FROM python:3.11-slim-bookworm

# Set the working directory in the container
WORKDIR /app

# Install production dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code into the container
COPY . .

# Expose the port that the Flask app will listen on
# Cloud Run expects the application to listen on the port specified by the PORT environment variable.
ENV PORT 8080

# Command to run the Flask application
# Use Gunicorn, a production-ready WSGI server, instead of Flask's built-in server
CMD exec gunicorn --bind :$PORT --workers 1 --threads 8 app:app