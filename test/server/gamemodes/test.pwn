#include <a_samp>

main() {
	printf("hello!");
	
	SetTimer("PrintSomething", 400, true);
}

forward PrintSomething();
public PrintSomething() {
	printf("The time is %d.", gettime());
}