FROM public.ecr.aws/docker/library/python:3.13-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY batch_runner.py .

ENV PYTHONUNBUFFERED=1

RUN useradd -m -u 1000 batch_user
USER batch_user

CMD ["python", "batch_runner.py"]
